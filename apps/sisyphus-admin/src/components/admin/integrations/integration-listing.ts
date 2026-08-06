import { formatTimestamp } from '@sisyphus-admin/components/admin/format-timestamp'

import { describeCron, formatInZone, nextFireTimes } from './cron-schedule'
import type { IntegrationView } from './integrations-client'

/**
 * One integration, shaped for reading (T121).
 *
 * The same split `profile-listing.ts` makes: every value a card renders is derived here, in a
 * module with its own test, so the card is markup and the shaping is checkable. What gets shaped is
 * mostly the things that are wrong when they are computed inline — a schedule described from its
 * cron, fire times rendered in the board's zone rather than the reader's, and the difference
 * between an admin switching an integration off and the platform doing it after repeated failures.
 */

/** Everything the card shows, already rendered. */
export interface IntegrationReadouts {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly board: string
  readonly state: 'enabled' | 'disabled' | 'auto-disabled'
  readonly enabled: boolean
  readonly schedule: string
  readonly scheduleExpression: string
  readonly timezone: string
  /** The next runs, in the integration's own timezone (FR-155). Empty if unreadable. */
  readonly nextRuns: readonly string[]
  readonly mappingSummary: string
  readonly ceilings: string
  readonly claimedTicketCount: string
  readonly startedWorkflowCount: string
  readonly consecutiveFailures: string
  /** Present only when the platform took it out of circulation (FR-106). */
  readonly autoDisabledReason: string | undefined
  readonly lastRun: string
  readonly scheduleRegistered: boolean
}

/** The prefix `integration-health.ts` writes on a platform-initiated disable. */
const AUTO_DISABLED_PREFIX = 'auto-disabled after'

/**
 * Whether the platform disabled this integration, rather than an admin.
 *
 * The distinction is the whole point of showing it: "somebody turned this off" and "this has been
 * broken since Tuesday" call for different actions, and a single `disabled` chip says neither.
 */
export const wasAutoDisabled = (
  integration: Pick<IntegrationView, 'autoDisabledReason'>,
): boolean => integration.autoDisabledReason?.startsWith(AUTO_DISABLED_PREFIX) ?? false

const summariseMappings = (integration: IntegrationView): string => {
  if (integration.mappings.length === 0) {
    return 'none — every ticket found would be skipped'
  }

  const names = integration.mappings
    .map((mapping) => mapping.executionProfileName ?? mapping.executionProfileId)
    .slice(0, 3)

  return integration.mappings.length > 3
    ? `${names.join(', ')} and ${String(integration.mappings.length - 3)} more`
    : names.join(', ')
}

const summariseLastRun = (integration: IntegrationView): string => {
  const { lastRun } = integration

  if (lastRun === undefined) {
    return 'never ticked'
  }

  if (lastRun.error !== null) {
    return `${formatTimestamp(lastRun.startedAt)} — failed: ${lastRun.error}`
  }

  if (lastRun.endedAt === null) {
    return `${formatTimestamp(lastRun.startedAt)} — still running`
  }

  return `${formatTimestamp(lastRun.startedAt)} — examined ${String(lastRun.examinedCount)}, started ${String(lastRun.startedCount)}, skipped ${String(lastRun.skippedCount)}`
}

/**
 * Shape one integration for the card.
 *
 * @param integration - As the server returned it.
 * @param now - Injectable so the fire times a test asserts on are not a race against the clock.
 */
export const toIntegrationReadouts = (
  integration: IntegrationView,
  now: Date = new Date(),
): IntegrationReadouts => {
  const autoDisabled = wasAutoDisabled(integration)

  return {
    id: integration.id,
    name: integration.name,
    type: integration.type,
    board: `${integration.baseUrl} · ${integration.projectPrefix} · label ${integration.label}`,
    state: integration.enabled ? 'enabled' : autoDisabled ? 'auto-disabled' : 'disabled',
    enabled: integration.enabled,
    schedule: describeCron(integration.cronExpression),
    scheduleExpression: integration.cronExpression,
    timezone: integration.timezone,
    nextRuns: nextFireTimes(integration.cronExpression, integration.timezone, 5, now).map(
      (instant) => formatInZone(instant, integration.timezone),
    ),
    mappingSummary: summariseMappings(integration),
    ceilings: `${String(integration.perTickCeiling)} per tick, ${String(integration.rollingPeriodCeiling)} per ${String(integration.rollingPeriodMinutes)} minutes`,
    claimedTicketCount: String(integration.claimedTicketCount),
    startedWorkflowCount: String(integration.startedWorkflowCount),
    consecutiveFailures: String(integration.consecutiveFailures),
    autoDisabledReason: autoDisabled ? (integration.autoDisabledReason ?? undefined) : undefined,
    lastRun: summariseLastRun(integration),
    scheduleRegistered: integration.scheduleArn !== null,
  }
}
