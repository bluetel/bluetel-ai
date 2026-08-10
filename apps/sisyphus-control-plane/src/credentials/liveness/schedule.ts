import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { agentCredentials, credentialGroups } from '@bluetel-ai/sisyphus-api/db'
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm'

import type { CredentialAlerter } from '../health'

import type { CredentialExerciser, ExerciseOutcome } from './exercise'
import { exerciseCredential } from './exercise'

/**
 * The keep-alive schedule (T087, FR-035, FR-036, FR-038, SC-009).
 *
 * ## Why this exists at all, when selection already prefers the least recently used
 *
 * Because least-recently-used cannot reach the credentials that need it most. FR-034's preference
 * applies **within the group being drawn from**, and FR-062's group attachments are *ordered*: a
 * profile draws from its first attached group until that group is exhausted, and only then from the
 * second. A lower-preference group can therefore receive no traffic at all, for months, while LRU
 * inside the busy group reports itself as spreading load perfectly evenly. `select.ts` says the same
 * thing from the other side, and `research.md` R2 rejects "refresh on every allocation" for exactly
 * this reason.
 *
 * So the selection here is **group-blind on purpose** (FR-035, "independently of which group it
 * belongs to"). There is no join to `profile_credential_groups` and no ordering by `position`; the
 * only questions are whether the credential is idle, and whether anybody else is using it.
 *
 * ## Claiming is the conditional update, not a check
 *
 * `UPDATE agent_credentials SET state = 'held', held_by = 'keep_alive' WHERE id = :id AND state =
 * 'available'` — the same statement `lease/acquire.ts` claims a seat with, and the same reading of
 * zero rows affected: **somebody else won the row**. When that somebody is a workflow reservation,
 * keep-alive yields and moves on, which is FR-038 satisfied by the database rather than by timing.
 *
 * The tempting alternative is to read the state and then act on it. It passes every sequential test
 * — a leased credential is not in the due set, so it is never exercised — and it is wrong in exactly
 * the case the whole feature exists to prevent: two claimants both read `available`, both proceed,
 * and one agent identity is exercised by a keep-alive while a workflow is authenticated as it.
 * Nothing about that failure is visible in the row afterwards. `schedule.test.ts` drives the race
 * with both parties parked on the same row lock, in both orderings, and demonstrates its own teeth
 * by running a deliberately read-then-act claimer through the identical choreography and watching
 * two winners appear.
 *
 * The claim is expressed on the credential row and not as a `credential_leases` row because that
 * table's `workflow_id` is `not null` and a keep-alive has no workflow — see the note on `held_by`
 * in `db/schema/credential.ts`. That is also why the two claimants must share one conditional: it
 * is the only thing they both contend on.
 *
 * ## The seat is handed back whatever happened
 *
 * Release is in a `finally`, so a credential is never left `held` by a keep-alive that threw. That
 * matters more here than it would for a workflow: a workflow's stranded lease is swept by the FR-022
 * reconciler, which looks at `credential_leases` — and a keep-alive claim has no lease row for that
 * sweep to find. A leaked keep-alive claim would be a seat held by nothing, invisible to every
 * existing repair, until somebody edited the row by hand.
 *
 * Release uses the same `CASE` rule `lease/release.ts` does: back to `available` only if the row is
 * still `held`. A credential the exercise moved to `cooling_off` or `unhealthy` stays there —
 * release is not a repair, and a keep-alive that returned a broken credential to the pool would be
 * handing the next workflow the failure it had just discovered.
 *
 * ## What is skipped, and what deliberately is not
 *
 * Skipped: anything not `available` (which is FR-036's "currently leased", since a leased credential
 * is `held`), anything with `enabled = false` (FR-036's "disabled"), anything archived, anything
 * whose group is archived, and anything with no `secret_id` — FR-008 again, there is nothing to
 * exercise.
 *
 * **Not skipped: a credential in a group an administrator has disabled.** This is a judgement call
 * and it is worth stating. FR-036 names its two exemptions explicitly and neither is the group's
 * flag; FR-006 makes disabling a group a withholding from *selection*, which is a statement about
 * which runs may draw on it, not about whether the platform may prove it still works. And the
 * failure that would follow from the other reading is precisely SC-009's: a group disabled for a
 * month is a group whose every login has quietly lapsed by the time somebody re-enables it, which is
 * the pool rot FR-035 exists to prevent. An archived group is different and *is* skipped — that is
 * history rather than capacity (FR-066).
 */

/**
 * `agent_credentials.held_by` while a keep-alive holds the seat.
 *
 * The counterpart to `CREDENTIAL_HOLDER_WORKFLOW` in `lease/acquire.ts`, and named for the same
 * reason: two claimants that came to spell the discriminator differently would each be invisible to
 * the other's accounting, and it is the value the pool view reads to show its fourth holder kind
 * (FR-074).
 */
export const CREDENTIAL_HOLDER_KEEP_ALIVE = 'keep_alive'

/** The job's name, as `runJob` and the schedule both spell it. */
export const KEEP_ALIVE_JOB_NAME = 'keep-alive'

/**
 * How many credentials one pass will exercise.
 *
 * A bound rather than a target. Every exercise is a provider round trip, and a pass that walked an
 * entire pool in one invocation would turn a schedule into a burst — against the same provider whose
 * rate limit this feature has a whole state for. Anything not reached is still overdue on the next
 * pass, and the ordering below is oldest-first, so nothing starves.
 */
export const DEFAULT_KEEP_ALIVE_BATCH = 25

/** One credential the schedule thinks is overdue. */
export interface DueCredential {
  readonly agentCredentialId: string
  readonly credentialName: string
  readonly credentialGroupId: string
  /** `null` for a credential nothing has ever proved, which sorts first. */
  readonly lastExercisedAt: Date | null
}

export interface DueCredentialsOptions {
  /** Hours of idleness past which a credential is overdue — `SISYPHUS_KEEPALIVE_IDLE_HOURS`. */
  readonly idleHours: number
  readonly now?: Date
  /** Defaults to {@link DEFAULT_KEEP_ALIVE_BATCH}. */
  readonly limit?: number
}

/** What reads the due set. A pooled handle or an open transaction; it takes no lock either way. */
export type ScheduleReader = Pick<SisyphusDatabase, 'select'>

/**
 * Which credentials are overdue for an exercise, oldest first, regardless of group (FR-035).
 *
 * Reads and claims nothing — the same separation `allocate/select.ts` keeps from
 * `lease/acquire.ts`, and for the same reason: two passes being offered the same credential is
 * expected and harmless, and it is the claim below that resolves it. A `selectAndClaim` here would
 * be the seam the FR-038 guarantee leaked through.
 *
 * A credential with `last_exercised_at = null` is included and sorts **first**. That is the
 * newly-registered case, and it is the reading `select.ts` gives `last_used_at` for the same shape:
 * something never proved is the least recently proved thing there is, and proving a fresh login
 * early is worth more than waiting a day to find out it never worked.
 *
 * @param reader - A handle or transaction.
 * @param options - The idle threshold, the clock, and the batch bound.
 */
export const credentialsDueForKeepAlive = async (
  reader: ScheduleReader,
  options: DueCredentialsOptions,
): Promise<readonly DueCredential[]> => {
  const now = options.now ?? new Date()
  const idleSince = new Date(now.getTime() - options.idleHours * 60 * 60 * 1000)

  return (
    reader
      .select({
        agentCredentialId: agentCredentials.id,
        credentialName: agentCredentials.name,
        credentialGroupId: agentCredentials.credentialGroupId,
        lastExercisedAt: agentCredentials.lastExercisedAt,
      })
      .from(agentCredentials)
      .innerJoin(credentialGroups, eq(credentialGroups.id, agentCredentials.credentialGroupId))
      .where(
        and(
          // FR-036's "currently leased": a leased credential is `held`, and every other state is a
          // reason it should not be touched either. Naming only `available` means a state added to
          // the enum later is skipped by default, which is the safe direction.
          eq(agentCredentials.state, 'available'),
          // FR-036's "disabled". The credential's own flag; see the module note on the group's.
          eq(agentCredentials.enabled, true),
          isNull(agentCredentials.archivedAt),
          isNull(credentialGroups.archivedAt),
          // FR-008: nothing to fetch, so nothing to exercise.
          sql`${agentCredentials.secretId} is not null`,
          or(
            isNull(agentCredentials.lastExercisedAt),
            lt(agentCredentials.lastExercisedAt, idleSince),
          ),
        ),
      )
      // Nulls first, then oldest. Not Postgres's default for an ascending sort, so it is said
      // explicitly; the id breaks ties and is UUID v7, so the tie-break is itself chronological.
      .orderBy(sql`${agentCredentials.lastExercisedAt} asc nulls first`, asc(agentCredentials.id))
      .limit(options.limit ?? DEFAULT_KEEP_ALIVE_BATCH)
  )
}

/**
 * Take the seat for a keep-alive, or discover that somebody else has it.
 *
 * **The conditional update, and nothing else.** See the module note for why a read-then-act check
 * in its place would satisfy every sequential test and lose the FR-038 guarantee.
 *
 * @param db - A pooled handle. One statement, so no transaction of its own is needed: a single
 *   `UPDATE` is atomic, and the row lock it takes is what a competing claimant blocks on.
 * @param agentCredentialId - The credential to claim.
 * @returns `true` if this claim took the row, `false` if zero rows were affected — which is an
 *   answer and not a failure: a workflow reservation won, and keep-alive moves on.
 */
export const claimForKeepAlive = async (
  db: SisyphusDatabase,
  agentCredentialId: string,
): Promise<boolean> => {
  const claimed = await db
    .update(agentCredentials)
    .set({ state: 'held', heldBy: CREDENTIAL_HOLDER_KEEP_ALIVE })
    .where(and(eq(agentCredentials.id, agentCredentialId), eq(agentCredentials.state, 'available')))
    .returning({ id: agentCredentials.id })

  // Deliberately not `.length > 0` on an indexed access: the count is the whole answer, and
  // phrasing it as a count is what makes "zero rows means somebody else won" the literal reading.
  return claimed.length === 1
}

/**
 * Hand the seat back after an exercise, whatever the exercise concluded.
 *
 * The `CASE` is `lease/release.ts`'s rule restated for the other claimant: a credential the exercise
 * moved to `cooling_off` or `unhealthy` comes back to *that* state, because release is not a repair.
 * `held_by` is cleared unconditionally, because nobody is holding it either way.
 *
 * Conditional on `held_by = 'keep_alive'`, so a claim that has somehow already been taken over is
 * not stolen back — the same defensive shape as the claim itself.
 *
 * @param db - A pooled handle.
 * @param agentCredentialId - The credential to release.
 * @returns The state the credential was left in, or `undefined` if this keep-alive no longer held it.
 */
export const releaseKeepAliveClaim = async (
  db: SisyphusDatabase,
  agentCredentialId: string,
): Promise<string | undefined> => {
  const released = await db
    .update(agentCredentials)
    .set({
      state: sql`case when ${agentCredentials.state} = 'held' then 'available'::credential_state else ${agentCredentials.state} end`,
      heldBy: null,
    })
    .where(
      and(
        eq(agentCredentials.id, agentCredentialId),
        eq(agentCredentials.heldBy, CREDENTIAL_HOLDER_KEEP_ALIVE),
      ),
    )
    .returning({ state: agentCredentials.state })

  return released[0]?.state
}

/** What one credential's turn in the sweep produced. */
export interface KeepAliveAttempt {
  readonly agentCredentialId: string
  readonly credentialName: string
  readonly credentialGroupId: string
  /**
   * `yielded` is the FR-038 case: the conditional update matched nothing, so a workflow reservation
   * took the seat between the due set being read and the claim being attempted. Reported rather
   * than swallowed, because a pass that yielded on most of the pool is a pass that proved very
   * little, and a schedule that could not say so would look identical to one that had worked.
   */
  readonly result: ExerciseOutcome | { readonly outcome: 'yielded' }
  /** What the seat was left in. `undefined` when the claim was never taken. */
  readonly releasedTo: string | undefined
}

export interface KeepAliveSweepResult {
  readonly considered: number
  readonly attempts: readonly KeepAliveAttempt[]
  readonly exercised: number
  readonly cooledOff: number
  readonly failed: number
  readonly yielded: number
}

export interface SweepKeepAliveOptions {
  readonly db: SisyphusDatabase
  readonly exerciser: CredentialExerciser
  /** `SISYPHUS_KEEPALIVE_IDLE_HOURS`, passed in rather than read: jobs do not read configuration. */
  readonly idleHours: number
  readonly alerter?: CredentialAlerter
  readonly now?: Date
  readonly limit?: number
}

/** The credential's state as it now stands. Its own query, so it reads what was committed. */
const currentState = async (
  db: SisyphusDatabase,
  agentCredentialId: string,
): Promise<string | undefined> => {
  const rows = await db
    .select({ state: agentCredentials.state })
    .from(agentCredentials)
    .where(eq(agentCredentials.id, agentCredentialId))

  return rows[0]?.state
}

/**
 * One keep-alive pass: find the overdue seats, claim each in turn, exercise it, hand it back.
 *
 * Serial rather than concurrent, deliberately. The credentials in a pass are unrelated, so
 * parallelism would be safe — and it would put N simultaneous requests on the one provider whose
 * rate limit this feature has a whole state for, from a job whose entire purpose is to be
 * unobtrusive. A pass that takes longer costs nothing; a pass that provokes the limit it was
 * checking for costs the pool.
 *
 * @param options - The handle, the seam, the idle threshold, and optionally an alerter, a clock and
 *   a batch bound.
 * @returns Every attempt, and the counts a schedule can be alerted on.
 * @throws Whatever the exerciser throws. That is the platform failing rather than a provider
 *   answering — an unwired seam, a Secrets Manager refusal — and it is the same for every credential
 *   in the pass, so ending the pass loudly is right where continuing would mean N identical
 *   failures. The seat is still handed back first.
 */
export const sweepKeepAlive = async (
  options: SweepKeepAliveOptions,
): Promise<KeepAliveSweepResult> => {
  const { db, exerciser } = options
  const now = options.now ?? new Date()

  const due = await credentialsDueForKeepAlive(db, {
    idleHours: options.idleHours,
    now,
    limit: options.limit,
  })

  const attempts: KeepAliveAttempt[] = []

  for (const candidate of due) {
    const { agentCredentialId, credentialGroupId, credentialName } = candidate

    if (!(await claimForKeepAlive(db, agentCredentialId))) {
      attempts.push({
        agentCredentialId,
        credentialName,
        credentialGroupId,
        result: { outcome: 'yielded' },
        releasedTo: undefined,
      })
      continue
    }

    // From here the seat is ours and must be given back on every path out — including a throw. See
    // the module note on why a leaked keep-alive claim has no sweep to repair it.
    let result: ExerciseOutcome
    try {
      result = await exerciseCredential({
        db,
        exerciser,
        agentCredentialId,
        alerter: options.alerter,
        now,
      })
    } finally {
      await releaseKeepAliveClaim(db, agentCredentialId)
    }

    attempts.push({
      agentCredentialId,
      credentialName,
      credentialGroupId,
      result,
      // Read after the release, so the reported state is the one the seat was actually left in
      // rather than the one the exercise asked for.
      releasedTo: await currentState(db, agentCredentialId),
    })
  }

  const counted = (outcome: string): number =>
    attempts.filter((attempt) => attempt.result.outcome === outcome).length

  return {
    considered: due.length,
    attempts,
    exercised: counted('succeeded'),
    cooledOff: counted('cooling_off'),
    failed: counted('failed'),
    yielded: counted('yielded'),
  }
}
