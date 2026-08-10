import type { PanelLink } from './message'
import { workflowDetailUrl } from './message'

/**
 * **The FR-056 administrator alerts — the four conditions in the credential pool that actually
 * need a person, and nothing else.**
 *
 * ## Why this is a separate vocabulary from `NotificationEvent`, and must stay one
 *
 * `@bluetel-ai/sisyphus-api`'s `NOTIFICATION_EVENTS` is deliberately closed, and its own comment
 * says what it is closed around: *the set of things a **user** can be notified about*, and *the set
 * a preference row may reference*. Three properties follow from that, and all three are wrong for
 * these alerts.
 *
 * 1. **Every member can be switched off by its recipient.** `notification_preferences` lets a recipient turn an event off
 *    (FR-138). An administrator who could silence "a credential is broken" would be able to switch
 *    off the only mechanism by which FR-037 reaches a human, and the pool would drain into a pile of
 *    unattended outages with nothing anywhere saying it had happened.
 * 2. **Every member is about a workflow.** `notifications.workflow_id` is the row's subject, and the
 *    audience is that run's owner and watchers. These alerts are about a **seat**, and the audience
 *    is whoever administers capacity — a different question with a different answer.
 * 3. **The audiences must not be able to converge.** 003/FR-079 makes waiting for a credential,
 *    cooling off and parking silent to a workflow's *owner*, while leaving administrator alerting
 *    untouched. Two vocabularies is what keeps that separation structural: there is no member of
 *    this set that can be delivered to an owner, and no member of `NotificationEvent` that fires for
 *    a pool condition. One shared enum would make the separation a matter of which `if` somebody
 *    wrote.
 *
 * So the alerts are **not** written to `notifications`. That is a deliberate omission rather than an
 * oversight: the durable record of a seat's condition is the credential row itself —
 * `agent_credentials.state` and `last_failure_reason`, which FR-009 requires to be visible against
 * the credential — plus the FR-058 configuration trail. A second record of the same fact, filed
 * under a workflow-shaped table with a preference gate in front of it, would be the thing that
 * eventually disagreed with the pool view.
 *
 * ## What is here, and what is not
 *
 * This module is pure. It decides **which** alerts are due from a description of the pool, and what
 * each one says. It reads nothing, writes nothing and sends nothing; `./credential-alerter.ts` is
 * the port that delivers what this produces. That split is the same one `./coalesce.ts` and
 * `./delivery.ts` have, for the same reason: the interesting failures — an alert that does not fire,
 * an alert that fires every fifteen minutes for a seat nobody can do anything about — are decisions
 * about thresholds, and a decision about thresholds should be testable without a Slack client.
 */

/**
 * The four conditions FR-056 names, as this package spells them.
 *
 * | FR-056                                     | Kind                   |
 * | ------------------------------------------ | ---------------------- |
 * | a credential approaching expiry            | `approaching_expiry`   |
 * | a credential becoming unhealthy            | `became_unhealthy`     |
 * | a credential requiring re-login            | `requires_login`       |
 * | a lease held beyond a configurable expectation | `lease_held_too_long` |
 *
 * `requires_login` covers the first login as well as the re-login, because FR-072 makes them the
 * same path and — more to the point — the same job: a seat that has never been logged in and a seat
 * whose login has stopped working are both capacity on paper and nothing in practice, and both are
 * cleared by an administrator opening the login page. Splitting them would put two items on the
 * queue for one action.
 */
export const CREDENTIAL_ALERT_KINDS = [
  'approaching_expiry',
  'became_unhealthy',
  'requires_login',
  'lease_held_too_long',
] as const

export type CredentialAlertKind = (typeof CREDENTIAL_ALERT_KINDS)[number]

/** The run holding a seat, as the lease-hold alert has to be able to name it (FR-056). */
export interface CredentialAlertHolder {
  readonly workflowId: string
  readonly workflowState: string
  readonly acquiredAt: Date
}

/**
 * One seat, as the alerter needs to see it.
 *
 * Deliberately a **description** rather than a database row. Nothing in this package reads
 * `agent_credentials`, and nothing in it should: the pool query already exists in
 * `sisyphus-api`'s `credential-store.ts`, and a second query here would be a second definition of
 * what a held seat is. The sweep that runs this passes what it read.
 *
 * `lastExercisedAt` rather than an expiry timestamp, because **there is no expiry column and there
 * cannot honestly be one**. A subscription login expires through *disuse* (research R2), and the
 * window it expires after is unmeasured — which is exactly why `SISYPHUS_KEEPALIVE_IDLE_HOURS` is
 * configuration. Expiry is therefore projected from the last time the login was proved to work,
 * which is FR-053's "time until expiry **where known**": known where the seat has been exercised,
 * and honestly unknown where it never has.
 */
export interface CredentialAlertSubject {
  readonly agentCredentialId: string
  readonly name: string
  readonly credentialGroupName: string
  readonly state: string
  /** Whether a login has ever been captured. Null material is FR-008 as a data rule. */
  readonly hasLogin: boolean
  /** Last proof the login still works — by a workflow **or** by keep-alive (FR-035). */
  readonly lastExercisedAt: Date | null
  /** Rendered verbatim into the alert (FR-009). A reason, never material. */
  readonly lastFailureReason: string | null
  readonly holder: CredentialAlertHolder | null
}

/** One alert, before it is worded. */
export interface CredentialAlert {
  readonly kind: CredentialAlertKind
  readonly agentCredentialId: string
  readonly credentialName: string
  readonly credentialGroupName: string
  /** The one sentence that says what is wrong and what to do about it. */
  readonly summary: string
  /** The holding run, on `lease_held_too_long` and nowhere else. */
  readonly holder: CredentialAlertHolder | null
}

/**
 * **How far into its idle window a seat has to be before expiry is worth raising.**
 *
 * A fraction rather than a lead time in hours, and that is not a stylistic choice. The window
 * itself is a guess — research R2 records that the real idle-expiry period of a subscription login
 * is unknown, which is why `SISYPHUS_KEEPALIVE_IDLE_HOURS` is configuration with a conservative
 * 24-hour default. A fixed "warn four hours before" would be most of the window for a deployment
 * that tuned it down to six hours and a rounding error for one that measured it at a fortnight. A
 * fraction moves with whatever the window turns out to be.
 *
 * The last quarter, because the remedy — a keep-alive exercise or a run — is minutes of work, and
 * the alert exists to catch the case where the scheduled keep-alive is *itself* not running.
 */
export const EXPIRY_WARNING_FRACTION = 0.25

/** Everything {@link planCredentialAlerts} needs. Two knobs, both from the host's environment. */
export interface PlanCredentialAlertsInput {
  readonly subjects: readonly CredentialAlertSubject[]
  /**
   * The window after which an unexercised login is assumed to have expired —
   * `SISYPHUS_KEEPALIVE_IDLE_HOURS`.
   *
   * Passed in, never read from the environment here, for the reason `PanelLink.baseUrl` is: this
   * package is imported by two applications and must not know which one is running it.
   */
  readonly idleExpiryHours: number
  /**
   * How long a lease may be held before it is raised, naming the holding run —
   * `SISYPHUS_LEASE_HOLD_EXPECTATION_HOURS` (FR-056).
   *
   * **An expectation, not a ceiling.** Nothing is force-released on it. A parked run legitimately
   * holds a seat for a very long time (FR-019, FR-073), so what this buys is attention: it is the
   * mechanism by which "every seat is held by parked workflows and nobody noticed" becomes
   * somebody's problem before the queue does.
   */
  readonly leaseHoldExpectationHours: number
  readonly now: Date
}

const HOUR_MS = 3_600_000

/** Whole hours, for a sentence a person reads. */
const hoursBetween = (from: Date, to: Date): number =>
  Math.floor((to.getTime() - from.getTime()) / HOUR_MS)

/**
 * **Which alerts are due, and why each condition is where it is.**
 *
 * Four rules, evaluated per seat, and a seat may produce more than one — a credential that broke and
 * was never logged in afterwards is two true facts, and reporting one of them would leave the other
 * for somebody to discover.
 *
 * What deliberately raises **nothing**:
 *
 * - **A seat that is cooling off.** FR-076 says so in as many words: a provider limit clears without
 *   human action, so waking somebody for it teaches them to ignore the alert that matters. This is
 *   also why research R5 resolves an ambiguous provider response to `cooling_off` rather than
 *   `unhealthy` — a wrongly-cooled seat comes back by itself; a wrongly-unhealthy one waits on
 *   somebody noticing.
 * - **A run waiting for a seat.** FR-079. It is the queue's business and the pool view's, and it
 *   usually resolves in seconds.
 * - **A parked holder inside the expectation.** Parking is a normal outcome (FR-044) and a parked
 *   run keeps its seat by design (FR-073). It becomes an administrator's problem only when the hold
 *   passes the expectation, which is the fourth rule and not a fifth one.
 *
 * @param input - See {@link PlanCredentialAlertsInput}.
 * @returns Every alert due, in subject order. Empty is the ordinary answer for a healthy pool.
 */
export const planCredentialAlerts = (
  input: PlanCredentialAlertsInput,
): readonly CredentialAlert[] => {
  const alerts: CredentialAlert[] = []
  const idleWindowMs = input.idleExpiryHours * HOUR_MS
  const warnAfterMs = idleWindowMs * (1 - EXPIRY_WARNING_FRACTION)
  const expectationMs = input.leaseHoldExpectationHours * HOUR_MS

  for (const subject of input.subjects) {
    const base = {
      agentCredentialId: subject.agentCredentialId,
      credentialName: subject.name,
      credentialGroupName: subject.credentialGroupName,
      holder: null,
    } as const

    if (subject.state === 'unhealthy') {
      alerts.push({
        ...base,
        kind: 'became_unhealthy',
        summary:
          subject.lastFailureReason === null
            ? 'Its login is broken and it has been withheld from selection. No reason was recorded against it.'
            : `Its login is broken and it has been withheld from selection: ${subject.lastFailureReason}`,
      })
    }

    // Checked on `hasLogin` rather than on the state, because that is the fact that decides it:
    // FR-008 makes a seat with nowhere to fetch material from unusable by every code path, whatever
    // its state column says. A freshly registered seat and one whose capture never landed are the
    // same job to whoever has to fix it.
    if (!subject.hasLogin) {
      alerts.push({
        ...base,
        kind: 'requires_login',
        summary:
          'No login has been completed for it, so it is capacity on paper and nothing in practice. Log it in from the credential page.',
      })
    }

    // Only a seat that has been exercised can be projected towards expiry, and only one that is not
    // already broken is worth projecting: an `unhealthy` seat has a louder problem, and adding a
    // second line about it going stale would bury the first.
    if (
      subject.lastExercisedAt !== null &&
      subject.state !== 'unhealthy' &&
      input.now.getTime() - subject.lastExercisedAt.getTime() >= warnAfterMs
    ) {
      const idleHours = hoursBetween(subject.lastExercisedAt, input.now)
      alerts.push({
        ...base,
        kind: 'approaching_expiry',
        summary: `It has not been exercised for ${String(idleHours)} hours, against an assumed idle-expiry window of ${String(input.idleExpiryHours)}. A login that expires through disuse fails at the worst moment — when a run finally selects it.`,
      })
    }

    if (
      subject.holder !== null &&
      input.now.getTime() - subject.holder.acquiredAt.getTime() >= expectationMs
    ) {
      const heldHours = hoursBetween(subject.holder.acquiredAt, input.now)
      alerts.push({
        ...base,
        kind: 'lease_held_too_long',
        holder: subject.holder,
        // The holding run is named because the alert is otherwise unactionable: "a seat has been
        // held too long" tells an administrator that capacity is gone and nothing about where.
        summary: `It has been held by ${subject.holder.workflowState} workflow ${subject.holder.workflowId} for ${String(heldHours)} hours, against an expectation of ${String(input.leaseHoldExpectationHours)}. Nothing has been released — this is attention, not action.`,
      })
    }
  }

  return alerts
}

/** Human wording for each kind, in the order a reader meets it. */
const ALERT_HEADLINES: Readonly<Record<CredentialAlertKind, string>> = {
  approaching_expiry: 'is approaching expiry',
  became_unhealthy: 'is unhealthy',
  requires_login: 'needs logging in',
  lease_held_too_long: 'has been held longer than expected',
}

/** Where the pool view lives, so an alert is one click from the screen that explains it. */
export const credentialPoolUrl = (panel: PanelLink): string =>
  `${panel.baseUrl.replace(/\/+$/, '')}/admin/credentials/pool`

/**
 * Compose the direct message for one alert.
 *
 * Plain text and one fact per line, for the reason `composeWorkflowMessage` is: the message has to
 * survive a notification preview, an email digest and a screen reader, and none of those render
 * block kit.
 *
 * The link goes to the **pool view** rather than to the seat, because every one of these four
 * conditions is a capacity question before it is a credential question — an administrator woken by
 * one needs to know whether it is the only seat in its group before they decide how fast to move.
 * The lease-hold alert carries a second link, to the run that is holding it, which is the only thing
 * that makes it actionable.
 *
 * @param alert - As {@link planCredentialAlerts} produced it.
 * @param panel - Where the panel lives.
 */
export const composeCredentialAlertMessage = (alert: CredentialAlert, panel: PanelLink): string => {
  const lines = [
    `Agent credential ${alert.credentialName} ${ALERT_HEADLINES[alert.kind]}.`,
    `Group: ${alert.credentialGroupName}`,
    alert.summary,
    `Pool: ${credentialPoolUrl(panel)}`,
  ]

  if (alert.holder !== null) {
    lines.push(`Holding run: ${workflowDetailUrl(panel, alert.holder.workflowId)}`)
  }

  return lines.join('\n')
}
