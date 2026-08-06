import type { IntegrationRun } from '@bluetel-ai/sisyphus-api/db'

import type { IntegrationTickDependencies, TickOutcome } from './integration-tick'
import { integrationTick } from './integration-tick'
import type { JobOutcome } from './run-job'
import { runJob } from './run-job'

/**
 * **Listening for `NOTIFY sisyphus_integration_tick` without being able to fail silently (FR-035,
 * FR-097, FR-107).**
 *
 * `admin.integrations.runNow` and `POST /api/webhook` both end the same way: a `pg_notify` on this
 * channel. Neither calls the control plane, because FR-035 gives it no inbound network surface — the
 * edge between the panel and the control plane is the database, exactly as it is for admission. So
 * something has to be on the other end of that channel, and until now nothing was: every "Run now"
 * an admin has ever pressed has been answered `{ requested: true }` and then dropped.
 *
 * ## Why this is not simply `sql.listen(...)`
 *
 * Spike S3 (`apps/sisyphus-admin/src/app/api/stream/SPIKE-FINDINGS.md`) measured what happens to
 * `LISTEN/NOTIFY` through a transaction-mode pooler, and the finding is binding here:
 *
 * - the `LISTEN` **succeeds** — no exception, no error frame, no connection close;
 * - **0 of 300** notifications were delivered;
 * - the only evidence anywhere was a warning in PgBouncer's own log;
 * - and the registration **leaks into the pool**, so the same code can appear to work with one idle
 *   client and deliver nothing under load. That is how it reaches production undetected.
 *
 * A subscriber that trusts a successful `LISTEN` is therefore indistinguishable from a platform
 * whose admins have simply not pressed the button. The spike's own conclusion — *alarm on the
 * absence, not on errors; there are no errors* — is what this module implements.
 *
 * ## The probe is the mechanism, not a health check bolted on
 *
 * {@link TickSignalListener.probe} emits a notification **on the same channel and the same
 * subscription the real signals arrive on**, carrying a one-off token, and waits for it to come
 * back. Delivery of a signal the listener itself produced is the only evidence that a signal
 * somebody else produces would arrive. It runs once at start-up, before the listener reports itself
 * usable, and again whenever the deployment asks — {@link runTickTransportProbe} is the job form, so
 * the existing scheduler can re-prove it on a timer without this module owning one.
 *
 * A failed probe does not throw and does not quietly retry. It calls `onTransportLost` with the
 * reason and reports `verified: false`, so a deployment that ignores it has *chosen* to, which is
 * the difference between this and the failure mode above.
 *
 * ## Why there is no poll behind it, stated plainly
 *
 * A polling fallback would be preferable — it cannot fail silently at all — and it is not available
 * for **this** signal, because the signal has no durable record. `runNow` performs one `pg_notify`
 * and writes nothing; the webhook route does the same. There is no `tick_requested_at` column and no
 * request table, so there is nothing for a poll to read: a poll could only re-derive due-ness from
 * `cron_expression`, which is the scheduled tick that EventBridge already owns (FR-099) and not the
 * manual one at all. Making the manual signal readable by a poll is a schema change plus a write in
 * `runNow`; until then, the probe is what stops the gap being invisible.
 *
 * ## Nothing here opens a connection
 *
 * The transport is a port ({@link TickSignalSource}), so every test in this file runs against a fake
 * and none of them touches a database or a socket. {@link createSqlTickSignalSource} adapts a
 * `postgres` handle structurally — it names no driver type and imports no driver — and it must be
 * given a **direct** handle. Handing it the pooled one is the configuration this module exists to
 * catch, and the start-up probe catches it.
 */

/**
 * The channel, restated.
 *
 * It is the literal in `admin.integrations.runNow` and in `POST /api/webhook`, and it is restated
 * here rather than imported because `@bluetel-ai/sisyphus-api` publishes it behind `/server`'s admin
 * barrel and the control plane has no reason to pull the whole interactive surface in to read one
 * string. `integration-tick-signal.test.ts` pins the literal, so a rename on either side fails a
 * test rather than producing a listener nobody notices is on the wrong channel.
 */
export const TICK_SIGNAL_CHANNEL = 'sisyphus_integration_tick'

/** Marks a payload this listener produced for itself. A uuid can never begin with it. */
export const PROBE_PAYLOAD_PREFIX = 'transport-probe:'

/** The probe payload for one token. */
export const probePayload = (token: string): string => `${PROBE_PAYLOAD_PREFIX}${token}`

/** Whether a delivered payload is a probe rather than an integration id. */
export const isProbePayload = (payload: string): boolean => payload.startsWith(PROBE_PAYLOAD_PREFIX)

/** What a lost transport is reported as. Names the cause the spike actually measured. */
export const TRANSPORT_UNVERIFIED_REASON =
  'A notification this listener sent to itself on sisyphus_integration_tick did not come back. ' +
  'LISTEN succeeds and delivers nothing through a transaction-mode pooler (spike S3), so every ' +
  'manual tick and every webhook delivery is being dropped without an error anywhere. Point this ' +
  'listener at a direct connection, or run the pooler in session mode.'

/** A live subscription to the channel. */
export interface TickSignalSubscription {
  readonly close: () => Promise<void>
}

/**
 * The transport, as a port.
 *
 * `emit` exists for the probe and for nothing else — this process never asks for a tick, it answers
 * one. It is on the same interface as `subscribe` deliberately: a probe that went out by a different
 * route would prove a different route.
 */
export interface TickSignalSource {
  readonly subscribe: (
    channel: string,
    onPayload: (payload: string) => void,
  ) => Promise<TickSignalSubscription>
  readonly emit: (channel: string, payload: string) => Promise<void>
}

/** What one probe established. */
export interface TransportVerification {
  readonly verified: boolean
  /** Present only when the probe failed. */
  readonly reason?: string
}

export interface TickSignalListenerOptions {
  readonly source: TickSignalSource
  /** What a delivered integration id causes. See {@link createManualTicker}. */
  readonly tick: (integrationId: string) => Promise<void>
  /**
   * Called whenever a probe fails, with the reason. Required, not optional: an unverified transport
   * that nothing was told about is precisely the silent failure this module is here to prevent.
   */
  readonly onTransportLost: (reason: string) => void
  /** Called when a tick throws. The listener keeps running: one bad board is not the channel. */
  readonly onTickFailed?: (integrationId: string, error: Error) => void
  /** How long a probe may take. Generous, because a slow database is not a broken transport. */
  readonly probeTimeoutMs?: number
  /** Injectable so a test states its token rather than matching one. */
  readonly newToken?: () => string
}

export interface TickSignalListener {
  /** Prove the transport again. Safe to call at any time; the deployment chooses how often. */
  readonly probe: () => Promise<TransportVerification>
  /** Whether the most recent probe succeeded. */
  readonly verified: () => boolean
  readonly close: () => Promise<void>
}

/** Long enough that a loaded database is not mistaken for a dead channel. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000

const defaultToken = (): string => `${String(Date.now())}-${Math.random().toString(36).slice(2)}`

/**
 * Subscribe to the channel and prove that the subscription delivers.
 *
 * @param options - See {@link TickSignalListenerOptions}.
 * @returns The listener. Check {@link TickSignalListener.verified}: a `false` means every manual
 *   tick is being dropped, and the reason has already gone to `onTransportLost`.
 */
export const startTickSignalListener = async (
  options: TickSignalListenerOptions,
): Promise<TickSignalListener> => {
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const newToken = options.newToken ?? defaultToken
  const awaitedProbes = new Map<string, () => void>()
  /** Ids signalled while their own tick was in flight, collapsed to one follow-up (FR-103). */
  const queued = new Set<string>()
  const running = new Set<string>()
  let verified = false

  const runTick = async (integrationId: string): Promise<void> => {
    if (running.has(integrationId)) {
      queued.add(integrationId)
      return
    }

    running.add(integrationId)

    try {
      await options.tick(integrationId)
    } catch (thrown) {
      options.onTickFailed?.(
        integrationId,
        thrown instanceof Error ? thrown : new Error(String(thrown)),
      )
    } finally {
      running.delete(integrationId)
    }

    if (queued.delete(integrationId)) {
      await runTick(integrationId)
    }
  }

  const subscription = await options.source.subscribe(TICK_SIGNAL_CHANNEL, (payload) => {
    if (isProbePayload(payload)) {
      awaitedProbes.get(payload)?.()
      return
    }

    void runTick(payload)
  })

  const probe = async (): Promise<TransportVerification> => {
    const payload = probePayload(newToken())

    const delivered = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        awaitedProbes.delete(payload)
        resolve(false)
      }, probeTimeoutMs)

      awaitedProbes.set(payload, () => {
        clearTimeout(timer)
        awaitedProbes.delete(payload)
        resolve(true)
      })

      void options.source.emit(TICK_SIGNAL_CHANNEL, payload).catch(() => {
        clearTimeout(timer)
        awaitedProbes.delete(payload)
        resolve(false)
      })
    })

    verified = delivered

    if (!delivered) {
      options.onTransportLost(TRANSPORT_UNVERIFIED_REASON)
      return { verified: false, reason: TRANSPORT_UNVERIFIED_REASON }
    }

    return { verified: true }
  }

  await probe()

  return {
    probe,
    verified: () => verified,
    close: async () => {
      await subscription.close()
    },
  }
}

/** The trigger every signalled tick is recorded under. An admin pressed a button (FR-097). */
export const SIGNALLED_TICK_TRIGGER: IntegrationRun['trigger'] = 'manual'

/**
 * What a delivered integration id does: one tick, recorded as manual.
 *
 * Built here rather than in the composition root so the trigger is stated once, next to the channel
 * it arrives on. A signalled tick is subject to the same ceilings, the same claim and the same run
 * record as a scheduled one, because it *is* the same tick (FR-102, FR-105, FR-107).
 *
 * @param dependencies - Everything `integrationTick` reaches outside the database.
 */
export const createManualTicker =
  (dependencies: IntegrationTickDependencies) =>
  async (integrationId: string): Promise<TickOutcome> =>
    integrationTick({ ...dependencies, integrationId, trigger: SIGNALLED_TICK_TRIGGER })

export const TICK_TRANSPORT_PROBE_JOB_NAME = 'integration-tick-transport-probe'

/**
 * Re-prove the transport, as a job.
 *
 * The listener owns no timer, because this app already has a scheduler and a second one inside a
 * long-lived process is a thing that stops running without anybody noticing. A deployment runs this
 * on whatever cadence it alarms on.
 *
 * @param listener - The running listener.
 */
export const runTickTransportProbe = (
  listener: TickSignalListener,
): Promise<JobOutcome<TransportVerification>> =>
  runJob(TICK_TRANSPORT_PROBE_JOB_NAME, async () => {
    const verification = await listener.probe()

    if (!verification.verified) {
      // Thrown so the job outcome is a failure rather than a success carrying bad news. A scheduled
      // invocation that reported `ok: true` for a dead channel would be the silent failure again,
      // one layer up.
      throw new Error(verification.reason ?? TRANSPORT_UNVERIFIED_REASON)
    }

    return verification
  })

/**
 * The shape of a `postgres` handle this module needs, named structurally.
 *
 * Structural so no driver type is imported and no driver is bundled by this module. The handle must
 * be a **direct** connection: `LISTEN` through a transaction-mode pooler registers on a server
 * connection that is handed to somebody else, which is the failure the probe exists to catch.
 */
export interface ListenCapableSql {
  readonly listen: (
    channel: string,
    onNotify: (payload: string) => void,
  ) => Promise<{ readonly unlisten: () => Promise<unknown> }>
  readonly notify: (channel: string, payload: string) => Promise<unknown>
}

/**
 * Adapt a `postgres` handle to {@link TickSignalSource}.
 *
 * @param sql - A **direct** handle. See {@link ListenCapableSql}.
 */
export const createSqlTickSignalSource = (sql: ListenCapableSql): TickSignalSource => ({
  subscribe: async (channel, onPayload) => {
    const meta = await sql.listen(channel, onPayload)

    return {
      close: async () => {
        await meta.unlisten()
      },
    }
  },
  emit: async (channel, payload) => {
    await sql.notify(channel, payload)
  },
})
