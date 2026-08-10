import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { users } from '@bluetel-ai/sisyphus-api/db'
import type { CredentialPoolRow } from '@bluetel-ai/sisyphus-api/server'
import { readCredentialPool } from '@bluetel-ai/sisyphus-api/server'
import type {
  AlertRecipient,
  CredentialAlertDelivery,
  CredentialAlertSubject,
  CredentialPoolAlerter,
} from '@bluetel-ai/sisyphus-notify'
import { and, asc, eq } from 'drizzle-orm'

import type { JobOutcome } from './run-job'
import { runJob } from './run-job'

/**
 * **The FR-056 administrator alerts, on a schedule** — the sweep that reads the pool and hands what
 * it finds to `@bluetel-ai/sisyphus-notify`'s alerter.
 *
 * `planCredentialAlerts` decides which of the four conditions are due and `createCredentialPoolAlerter`
 * delivers them; both live in the notify package and both were written with no caller, because the
 * only thing that can read the pool on a cadence is a control-plane job. This is that job, and it is
 * deliberately thin: it reads two sets of rows, hands them over, and reports what came back.
 *
 * ## Why this is its own schedule and not a sixth section of `reconcile.ts`
 *
 * `reconcile.ts` has five sections and every one of them **repairs** something — a lease outliving
 * its run, an instance nothing holds a lease for, a pause nobody came back to, a seat outliving the
 * run that reserved it, a cooling-off credential whose limit has cleared. It runs inside the stage
 * tick, once a minute, and its failure mode matters: a sweep that frees compute must not be delayed
 * or failed by an outbound call to Slack. Alerting is the opposite kind of work — it changes nothing
 * and its whole product is a message to a person — so putting it there would have coupled the
 * platform's ability to reclaim capacity to a third party being reachable, which is the exact
 * coupling `reconcile.ts`'s own notifier note refuses. It would also have alerted **once a minute**
 * on a pool with no coalescing anywhere in the path, and a channel that repeats itself sixty times
 * an hour is a channel nobody reads.
 *
 * ## Why it is not part of the keep-alive sweep either
 *
 * Keep-alive is the closest neighbour: it is the other credential-shaped job, it runs on its own
 * platform schedule, and its cadence is already the right order of magnitude. It is still the wrong
 * host, and `credential-alerts.ts` in the notify package says why without meaning to — the expiry
 * alert exists to catch *the case where the scheduled keep-alive is itself not running*. An alert
 * that only fired as part of the job it is watching would go silent in precisely the situation it
 * was written for, which is SC-009's failure with an extra step. So it gets its own entry in
 * {@link import('./sync-schedules').PLATFORM_SCHEDULES}, for the same reason keep-alive has one:
 * a timer the platform needs whether or not anything else is working.
 *
 * ## What it reads, and why it reads it from `sisyphus-api`
 *
 * {@link readCredentialPool} — the same query the FR-053 pool view is built from. The alternative
 * was a query here, and it would have been a second definition of what a held seat is: the live
 * lease predicate, the left joins that keep a free seat in the result, and FR-074's parked-holder
 * rule are all decisions that already exist once. Two copies would disagree the first time one of
 * them changed, and the copy that disagreed silently would be this one, because nothing renders it.
 *
 * The recipients are read here rather than there, because who administers capacity is a platform
 * question and `users` is not the credential store's table.
 *
 * ## What it does not do
 *
 * It writes nothing. No `notifications` row, no state change, no audit entry — see the notify
 * package's `credential-alerts.ts` for the argument in full, chiefly that the durable record of a
 * seat's condition is the credential row itself and a second one filed under a workflow-shaped
 * table with a preference gate in front of it would be the thing that eventually disagreed with the
 * pool view. A sweep that raised an alert and also marked something would be able to make the pool
 * worse while reporting on it.
 */

/** The job's name, as `runJob` and the schedule both spell it. */
export const CREDENTIAL_ALERTS_JOB_NAME = 'credential-alerts'

/**
 * One seat, as the alerter needs to see it.
 *
 * The mapping is the whole of this function and every line of it is a decision the pool row already
 * made: `hasLogin` is `hasSecret`, because FR-008's "nothing to fetch material from" is the fact
 * that decides whether a login is needed; the holder is present only when the lease join found a
 * live one, and it carries the workflow's state so the alert can say *what kind* of run is sitting
 * on the seat.
 *
 * Archived seats never reach here — {@link readCredentialPool} excludes them by default, and an
 * archived credential is history rather than capacity (FR-005). Alerting that a retired seat needs
 * logging in would be a permanent item on somebody's list that no action could clear.
 */
export const alertSubjectFor = (row: CredentialPoolRow): CredentialAlertSubject => ({
  agentCredentialId: row.id,
  name: row.name,
  credentialGroupName: row.credentialGroupName,
  state: row.state,
  hasLogin: row.hasSecret,
  lastExercisedAt: row.lastExercisedAt,
  lastFailureReason: row.lastFailureReason,
  holder:
    row.holderWorkflowId === null
      ? null
      : {
          workflowId: row.holderWorkflowId,
          // Null only if the join found a lease whose workflow row has gone, which the foreign key
          // forbids. Reported as `unknown` rather than crashing the sweep: an alert naming a run
          // whose state could not be read is still an alert an administrator can act on.
          workflowState: row.holderWorkflowState ?? 'unknown',
          // Same argument. `acquired_at` is `not null` on a live lease; the fallback keeps a
          // malformed row from silencing every other seat's alert.
          acquiredAt: row.holderAcquiredAt ?? new Date(0),
        },
})

/** What reads the pool and the administrators. A pooled handle; it takes no lock and writes nothing. */
export type CredentialAlertReader = Pick<SisyphusDatabase, 'select'>

/**
 * Who hears about a broken seat: **every active administrator** (FR-056, FR-053).
 *
 * Not the run's owner, not a watcher, and not a preference-filtered subset. These alerts are about
 * capacity rather than about a run, so the audience is whoever can do something about capacity —
 * and `notification_preferences` deliberately has no member for them, because an administrator able
 * to switch off "a credential is broken" could switch off the only mechanism by which a pool outage
 * reaches a person.
 *
 * Deactivated administrators are excluded. FR-176 makes deactivation take effect at the next
 * request rather than at next sign-in, and messaging somebody the platform has already decided is
 * not an administrator would be the same mistake in the outbound direction.
 *
 * A `null` Slack id is **kept** rather than filtered out here. The alerter reports that recipient as
 * `unnotifiable`, which is a fact worth having in the job's result — an administrator nobody can
 * reach is a gap in the alerting path, and a sweep that quietly dropped them would report perfect
 * delivery to an audience of nobody.
 */
export const readAlertRecipients = async (
  reader: CredentialAlertReader,
): Promise<readonly AlertRecipient[]> =>
  reader
    // `display_name`, never the adapter's nullable `name`: the schema note on `users` says why —
    // `name` is whatever Google last returned and an IdP profile rename must not rewrite the name
    // the platform addresses somebody by.
    .select({ userId: users.id, displayName: users.displayName, slackUserId: users.slackUserId })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.isActive, true)))
    .orderBy(asc(users.id))

export interface SweepCredentialAlertsOptions {
  readonly db: SisyphusDatabase
  /**
   * Where alerts go.
   *
   * Optional, and an absent one makes this sweep a **no-op that says so** rather than a failure.
   * That is the `WorkflowNotifier` asymmetry rather than the refusing-port one: an unwired alerter
   * withholds a message and breaks nothing, whereas a sweep that threw would put a failing job on
   * every schedule in a deployment that has simply not configured Slack. The composition root does
   * wire one — see `src/context.ts` — so the absent case is a test's, and a deployment's for as long
   * as it is being stood up.
   */
  readonly alerter?: CredentialPoolAlerter
  /** Injectable clock, so a threshold can be crossed in a test without waiting for it. */
  readonly now?: Date
}

export interface SweepCredentialAlertsResult {
  /** Seats considered, alerts due or not. The denominator for "nothing to say" being good news. */
  readonly considered: number
  /** Administrators the alerts were addressed to, reachable or not. */
  readonly recipients: number
  /**
   * One entry per alert per administrator, exactly as the alerter reported it.
   *
   * Carried out of the job rather than summarised to a count, because the three outcomes mean
   * different things and only one of them is a problem to chase: `unnotifiable` is a fact about a
   * person's Slack identity, `failed` is an outage worth retrying, and a sweep that reported "12
   * alerts sent" would have hidden both.
   */
  readonly deliveries: readonly CredentialAlertDelivery[]
  /** True when no alerter was wired. See {@link SweepCredentialAlertsOptions.alerter}. */
  readonly skipped: boolean
}

/**
 * Read the pool, and raise whatever FR-056 says is due.
 *
 * **The recipients are read even when there are no alerts**, and the cheap-looking reordering — plan
 * first, only read administrators if something is due — is deliberately not done. `planCredentialAlerts`
 * lives behind the port, so this job cannot ask what is due without also asking for it to be sent;
 * pulling that decision out here to save one indexed query on a small table would be duplicating the
 * thresholds, which is the one thing the notify package's whole shape exists to prevent.
 *
 * Nothing here throws on a delivery failure, because nothing in the alerter does: every outage, every
 * closed direct message and every administrator with no Slack identity comes back as a delivery with
 * an outcome on it. What can still throw is the pool read, and it should — a sweep that could not
 * read the pool has not established that there is nothing to say.
 *
 * @param options - The handle, the alerter and optionally the clock.
 * @returns What was considered, who it was addressed to, and what each delivery did.
 */
export const sweepCredentialAlerts = async (
  options: SweepCredentialAlertsOptions,
): Promise<SweepCredentialAlertsResult> => {
  const rows = await readCredentialPool(options.db)

  if (options.alerter === undefined) {
    return { considered: rows.length, recipients: 0, deliveries: [], skipped: true }
  }

  const administrators = await readAlertRecipients(options.db)

  const deliveries = await options.alerter.raise({
    subjects: rows.map(alertSubjectFor),
    administrators,
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  return {
    considered: rows.length,
    recipients: administrators.length,
    deliveries,
    skipped: false,
  }
}

/** The scheduled entry point. See `dispatch.ts` for the event that names it. */
export const runCredentialAlerts = (
  options: SweepCredentialAlertsOptions,
): Promise<JobOutcome<SweepCredentialAlertsResult>> =>
  runJob(CREDENTIAL_ALERTS_JOB_NAME, () => sweepCredentialAlerts(options))
