import type { CredentialAlert, CredentialAlertSubject } from './credential-alerts'
import { composeCredentialAlertMessage, planCredentialAlerts } from './credential-alerts'
import type { PanelLink } from './message'
import type { SlackDirectMessenger } from './slack'

/**
 * **The port an administrator alert goes out through (FR-056), and how it learns its thresholds.**
 *
 * `./credential-alerts.ts` decides which alerts are due; this sends them. The split is the one
 * `./notifier.ts` has over `./delivery.ts`, and the argument is identical: a job that had to
 * assemble a Slack client to raise a broken credential is a job that fails when Slack is down, and
 * the one thing that must not depend on Slack being up is the mechanism for reporting that something
 * is broken.
 *
 * ## Where `SISYPHUS_LEASE_HOLD_EXPECTATION_HOURS` comes from, and why it arrives this way
 *
 * The knob lives in `apps/sisyphus-control-plane/src/env-schemas.ts`, and this package must not
 * reach it. The arrow between them runs the other way — the control plane depends on this package —
 * and a package that read an application's environment would be unusable from the other application
 * that imports it, which for this repository is `apps/sisyphus-admin`.
 *
 * So it is a **constructor parameter**, bound once in whichever host runs the sweep, exactly as
 * `PanelLink.baseUrl` is. That precedent is not an analogy: `./message.ts` states it in full — the
 * panel's base URL is passed in because the control plane's environment has no variable naming it,
 * and reading an absent variable would have produced `undefined` in the middle of a URL in a message
 * to a person. Here the failure would be quieter and worse. A default read from nowhere would be a
 * threshold that silently disagreed with the deployment's configured one, and the symptom is an
 * alert that does not fire.
 *
 * The same reasoning applies to `idleExpiryHours` (`SISYPHUS_KEEPALIVE_IDLE_HOURS`). Neither has a
 * default here, deliberately: a default in this file would be a second copy of a number that already
 * has one in `env-schemas.ts`, and the two would drift the first time somebody tuned the real one.
 * Requiring both makes wiring the alerter impossible without deciding them.
 *
 * `sisyphus-api` declares its own ports the same way, on `SisyphusDependencies` in
 * `server/context.ts` — `agentCredentialLogin`, `agentCredentialMaterial`, `notifier` — each one a
 * seam a host fills because the implementation lives in an application. This is that pattern applied
 * from the package that *is* the implementation.
 *
 * ## What a holder of this cannot do
 *
 * Read the pool, write to it, or reach a database. {@link CredentialPoolAlerter.raise} is handed a
 * description of the seats and a list of people, and it sends messages. It cannot mark a credential
 * unhealthy, cannot release a lease, and cannot record anything — which is what keeps an alerting
 * failure from becoming a pool failure, the same property `./delivery.ts` has about workflow state
 * and for the same reason.
 */

/** One administrator an alert may reach. The audience for every alert in this module. */
export interface AlertRecipient {
  readonly userId: string
  readonly displayName: string
  /** Null for an administrator with no resolvable Slack identity (FR-140's shape, admin-side). */
  readonly slackUserId: string | null
}

/** What one alert did, for one administrator. */
export interface CredentialAlertDelivery {
  readonly alert: CredentialAlert
  readonly recipientUserId: string
  readonly outcome: 'delivered' | 'unnotifiable' | 'failed'
  readonly error: string | null
}

/** What {@link CredentialPoolAlerter.raise} is asked to consider. */
export interface CredentialAlertNotice {
  /** The pool as the caller read it. See {@link CredentialAlertSubject} for why it is a description. */
  readonly subjects: readonly CredentialAlertSubject[]
  /** Who administers capacity. Read by the caller, because who that is is a platform question. */
  readonly administrators: readonly AlertRecipient[]
  readonly now?: Date
}

/** **The port.** One method, and it only sends messages. */
export interface CredentialPoolAlerter {
  readonly raise: (notice: CredentialAlertNotice) => Promise<readonly CredentialAlertDelivery[]>
}

/** The messenger, where the panel is, and the two thresholds. Assembled once, in a host. */
export interface CredentialPoolAlerterOptions {
  readonly messenger: SlackDirectMessenger
  readonly panel: PanelLink
  /** `SISYPHUS_KEEPALIVE_IDLE_HOURS`. No default — see the module note. */
  readonly idleExpiryHours: number
  /** `SISYPHUS_LEASE_HOLD_EXPECTATION_HOURS`. No default — see the module note. */
  readonly leaseHoldExpectationHours: number
}

/** Turn an unknown thrown value into a message without losing its content. */
const describe = (thrown: unknown): string =>
  thrown instanceof Error ? thrown.message : String(thrown)

/**
 * Bind the port to the thresholds and the messenger.
 *
 * **Nothing here throws.** Every failure mode — a Slack outage, an administrator with no Slack
 * identity, a closed direct message — comes back as a {@link CredentialAlertDelivery} with an
 * outcome on it. A caller that had to wrap this in a `try` would eventually be a caller that did
 * not, and the thrown error would land in whatever sweep was doing something more important. The
 * distinction between `failed` and `unnotifiable` is the one `./delivery.ts` draws: an outage is
 * retryable and is not a fact about the person.
 *
 * @param options - See {@link CredentialPoolAlerterOptions}.
 */
export const createCredentialPoolAlerter = (
  options: CredentialPoolAlerterOptions,
): CredentialPoolAlerter => {
  const { messenger, panel, idleExpiryHours, leaseHoldExpectationHours } = options

  return {
    raise: async (notice) => {
      const alerts = planCredentialAlerts({
        subjects: notice.subjects,
        idleExpiryHours,
        leaseHoldExpectationHours,
        now: notice.now ?? new Date(),
      })

      const deliveries: CredentialAlertDelivery[] = []

      for (const alert of alerts) {
        const text = composeCredentialAlertMessage(alert, panel)

        for (const recipient of notice.administrators) {
          if (recipient.slackUserId === null || recipient.slackUserId === '') {
            deliveries.push({
              alert,
              recipientUserId: recipient.userId,
              outcome: 'unnotifiable',
              error: 'The administrator has no resolvable Slack identity.',
            })
            continue
          }

          let channelId: string | undefined
          try {
            channelId = await messenger.openDirectMessage({ slackUserId: recipient.slackUserId })
          } catch (thrown) {
            deliveries.push({
              alert,
              recipientUserId: recipient.userId,
              outcome: 'failed',
              error: describe(thrown),
            })
            continue
          }

          if (channelId === undefined) {
            deliveries.push({
              alert,
              recipientUserId: recipient.userId,
              outcome: 'unnotifiable',
              error: 'Slack would not open a direct message with this administrator.',
            })
            continue
          }

          try {
            await messenger.postMessage({ channelId, text })
            deliveries.push({
              alert,
              recipientUserId: recipient.userId,
              outcome: 'delivered',
              error: null,
            })
          } catch (thrown) {
            deliveries.push({
              alert,
              recipientUserId: recipient.userId,
              outcome: 'failed',
              error: describe(thrown),
            })
          }
        }
      }

      return deliveries
    },
  }
}
