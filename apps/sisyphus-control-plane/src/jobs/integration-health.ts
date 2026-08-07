import type { Integration, SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { integrations } from '@bluetel-ai/sisyphus-api/db'
import { eq, sql } from 'drizzle-orm'

/**
 * Consecutive-failure tracking and auto-disable (T120, FR-106, FR-108).
 *
 * ## Why an integration disables itself
 *
 * An integration spends money unattended on behalf of everyone (FR-186). One that cannot reach its
 * board fails every tick — and a failing tick is not free: it wakes a scheduled invocation, opens a
 * run record, and reads a secret, every fifteen minutes, indefinitely. More to the point, a
 * connector failing for a reason nobody looked at is exactly the state `integration_runs` exists to
 * make visible (FR-105), and an integration that has failed five times running has a problem a
 * human has to fix. So past the threshold it takes itself out of circulation with the reason
 * recorded, rather than retrying until someone notices the bill.
 *
 * ## Consecutive, not cumulative
 *
 * `consecutive_failures` is reset to zero by **any** successful tick. An integration that fails once
 * a week for a year has not earned a disable; one that has failed five times in a row is broken
 * now. Counting cumulatively would eventually disable every healthy integration on the platform,
 * which is the kind of rule that looks prudent and produces an outage.
 *
 * ## Re-enabling is a human act
 *
 * Nothing here ever sets `enabled` back to true, and `auto_disabled_reason` is left in place until
 * an admin enables the integration again (`admin.integrations.setEnabled`, which clears it). An
 * integration that could re-enable itself would oscillate: fail five times, disable, un-disable,
 * fail five times. The reason is kept so the panel can say *why* it is off, which is the difference
 * between "somebody turned this off" and "this has been broken since Tuesday".
 *
 * ## The counter is updated with SQL rather than with a read-then-write
 *
 * `consecutive_failures = consecutive_failures + 1` is evaluated by Postgres. Reading the row,
 * adding one and writing it back would lose an increment whenever two ticks for one integration
 * overlapped — which FR-103 makes unlikely and not impossible, and losing an increment is
 * indistinguishable from a tick that succeeded.
 */

/** Failures in a row before an integration takes itself out of circulation (FR-106). */
export const DEFAULT_FAILURE_THRESHOLD = 5

/** Prefix on `auto_disabled_reason`, so the panel can tell a platform disable from an admin's. */
export const AUTO_DISABLED_PREFIX = 'auto-disabled after'

/** The sentence written onto the row, and shown in the panel. */
export const autoDisabledReason = (failures: number, reason: string): string =>
  `${AUTO_DISABLED_PREFIX} ${String(failures)} consecutive failed ticks: ${reason}`

export type HealthWriter = Pick<SisyphusDatabase, 'select' | 'update'>

export interface RecordRunOutcomeInput {
  readonly integrationId: string
  readonly succeeded: boolean
  /** Why the tick failed. Never a credential and never ticket content (FR-072, FR-098). */
  readonly reason?: string
  /** Overridable so a test states the threshold it is about rather than looping five times. */
  readonly threshold?: number
}

export interface IntegrationHealth {
  readonly integrationId: string
  readonly consecutiveFailures: number
  readonly enabled: boolean
  /** True only on the tick that crossed the threshold, so it can be reported once. */
  readonly autoDisabled: boolean
  readonly autoDisabledReason: string | null
}

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * Record how one tick ended, and disable the integration if it has now failed too often.
 *
 * @param writer - A handle or an open transaction.
 * @param input - See {@link RecordRunOutcomeInput}.
 * @returns The integration's health after this tick.
 * @throws If the integration does not exist — a tick recorded against a row that has gone means the
 *   caller and the database disagree about what is being ticked.
 */
export const recordRunOutcome = async (
  writer: HealthWriter,
  input: RecordRunOutcomeInput,
): Promise<IntegrationHealth> => {
  const threshold = input.threshold ?? DEFAULT_FAILURE_THRESHOLD

  if (input.succeeded) {
    const cleared = firstRow(
      await writer
        .update(integrations)
        // The reason is cleared too: a board that answered is a board whose failure has ended, and
        // leaving the sentence behind would have the panel explaining a fault that is over.
        .set({ consecutiveFailures: 0, autoDisabledReason: null })
        .where(eq(integrations.id, input.integrationId))
        .returning({
          id: integrations.id,
          consecutiveFailures: integrations.consecutiveFailures,
          enabled: integrations.enabled,
          autoDisabledReason: integrations.autoDisabledReason,
        }),
    )

    if (cleared === undefined) {
      throw new Error(
        `Integration ${input.integrationId} does not exist, so a tick outcome cannot be recorded against it.`,
      )
    }

    return {
      integrationId: cleared.id,
      consecutiveFailures: 0,
      enabled: cleared.enabled,
      autoDisabled: false,
      autoDisabledReason: null,
    }
  }

  const bumped = firstRow(
    await writer
      .update(integrations)
      .set({ consecutiveFailures: sql`${integrations.consecutiveFailures} + 1` })
      .where(eq(integrations.id, input.integrationId))
      .returning({
        id: integrations.id,
        consecutiveFailures: integrations.consecutiveFailures,
        enabled: integrations.enabled,
        autoDisabledReason: integrations.autoDisabledReason,
      }),
  )

  if (bumped === undefined) {
    throw new Error(
      `Integration ${input.integrationId} does not exist, so a tick outcome cannot be recorded against it.`,
    )
  }

  if (bumped.consecutiveFailures < threshold || !bumped.enabled) {
    return {
      integrationId: bumped.id,
      consecutiveFailures: bumped.consecutiveFailures,
      enabled: bumped.enabled,
      autoDisabled: false,
      autoDisabledReason: bumped.autoDisabledReason,
    }
  }

  const reason = autoDisabledReason(
    bumped.consecutiveFailures,
    input.reason ?? 'the external system could not be reached',
  )

  const disabled = firstRow(
    await writer
      .update(integrations)
      // `schedule_arn` is left alone. Removing the schedule is `sync-schedules.ts`'s, which reads
      // `enabled`; doing it from two places is how a schedule survives its integration.
      .set({ enabled: false, autoDisabledReason: reason })
      .where(eq(integrations.id, input.integrationId))
      .returning({ id: integrations.id, consecutiveFailures: integrations.consecutiveFailures }),
  )

  return {
    integrationId: bumped.id,
    consecutiveFailures: disabled?.consecutiveFailures ?? bumped.consecutiveFailures,
    enabled: false,
    autoDisabled: true,
    autoDisabledReason: reason,
  }
}

/** Whether a row was taken out of circulation by the platform rather than by an admin. */
export const wasAutoDisabled = (integration: Pick<Integration, 'autoDisabledReason'>): boolean =>
  integration.autoDisabledReason?.startsWith(AUTO_DISABLED_PREFIX) ?? false
