import type { AgentCredential, SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { agentCredentials, configurationAudit } from '@bluetel-ai/sisyphus-api/db'
import { and, eq, inArray, sql } from 'drizzle-orm'

import type { HealthVerdict } from './classify'

/**
 * Applying a verdict to the credential row — and the one place a credential's state ever changes
 * for a health reason (FR-033, FR-037, FR-058, FR-076, SC-019).
 *
 * `classify.ts` decides; this writes. The split is not ceremony: the decision is a pure function of
 * a recorded response and is tested against a shelf of them, while the write is a transaction with
 * an audit row, a state guard and an alert hanging off it. Fused into one function neither half
 * could be tested for what it actually does.
 *
 * ## Alert on `unhealthy`, raise nothing on `cooling_off`
 *
 * This is the whole operational point of the distinction, and it is a rule about *notification*
 * rather than about severity. An `unhealthy` credential is out of the pool until a person repairs
 * it (FR-056 names "a credential becoming unhealthy" as an event worth an alert), so an alert is the
 * only thing that shortens the outage. A `cooling_off` credential is **alive** — the provider
 * answered, which is exactly what a keep-alive was checking — and it returns to the pool by itself
 * on the FR-076 sweep. SC-019 states the requirement as an absence: it "returns to service without
 * any administrator action, and generates no alert". Alerting on it anyway would fill the channel
 * with events that resolve themselves before anybody reads them, which is how the channel stops
 * being read, which is how the alert that mattered gets missed.
 *
 * So the alerter is consulted on exactly one branch, and {@link CredentialAlerter} has exactly one
 * method — there is deliberately no `credentialCoolingOff` for somebody to wire "just for
 * visibility".
 *
 * ## Every transition writes `state_changed`, naming both states
 *
 * FR-058 covers "every lease acquisition, release, forced release **and credential state change**",
 * and it is the last clause that is easy to lose: `acquire.ts` and `release.ts` already record
 * `leased`, `released` and `force_released`, which covers every state change that happens *because
 * of a lease*. The ones that happen because of the provider — available to cooling off, held to
 * unhealthy, cooling off back to available — pass through this module and nowhere else, so this is
 * where the remaining half of FR-058 is satisfied.
 *
 * The entry names **both** states. An entry recording only the new one cannot say what a transition
 * was from, and "what was it before?" is most of what makes a trail legible after the fact — it is
 * the difference between "this credential broke while a run held it" and "this credential was
 * already out of the pool and got worse".
 *
 * The audit row is written **inside** the transaction that changes the state, for the reason
 * `acquire.ts` sets out at length: a trail entry that outlived a rolled-back change is worse than
 * no entry, because it is an entry that cannot be believed.
 *
 * ## What a verdict may not overwrite
 *
 * {@link VERDICT_SOURCE_STATES} is the guard, and each exclusion is a bug it prevents.
 *
 * - **`disabled`** — an administrator withheld this credential (FR-006). A late verdict from a run
 *   that was still using it must not relabel the row, because re-enabling it would then return it
 *   to a state an administrator never chose.
 * - **`unhealthy`** — a broken login does not become a rate limit. Allowing it would let a
 *   `cooling_off` verdict quietly repair a credential that needs a person, and put it back in the
 *   pool on the next sweep (FR-076) with the breakage intact.
 * - **`awaiting_login`** — there is no material to have been refused. A verdict here would be about
 *   somebody else's request.
 *
 * `cooling_off` **is** a permitted source, and only for a `cooling_off` verdict: a run that hits the
 * limit again while waiting it out (FR-077) should extend the deadline rather than be ignored.
 *
 * ## What it deliberately does not touch
 *
 * **`held_by`.** The two columns answer different questions — `state` is whether the credential is
 * usable and `held_by` is who is using it — and a keep-alive exercise or a run is still holding the
 * row when the verdict lands. Clearing it here would show an idle seat in the pool view (FR-074)
 * while a run was still on it. It is cleared by whoever claimed it, when they hand it back.
 *
 * **The lease.** A credential going `cooling_off` or `unhealthy` mid-run does not release the seat
 * (FR-023): the run waits out a limit and fails naming the credential on a breakage, and either way
 * the lease ends through the ordinary terminal path. A health transition that released the lease
 * would be a substitution by the back door.
 *
 * **The fence.** Only acquisition raises it (research R9).
 */

/**
 * States a health verdict may be applied from. See the module note for what each exclusion prevents.
 *
 * Written as a list rather than as "anything but `disabled`" so that a state added to
 * `credential_state` later is excluded by default, which is the safe direction: a verdict that
 * silently applied to a state nobody had considered is how a new state's meaning gets overwritten
 * by the first provider hiccup after it ships.
 */
export const VERDICT_SOURCE_STATES = ['available', 'held', 'cooling_off'] as const

/** One credential the platform wants a person to look at (FR-037, FR-056). */
export interface UnhealthyCredentialAlert {
  readonly agentCredentialId: string
  readonly credentialName: string
  /** Where it was before it broke — usually `held`, which means a run was on it. */
  readonly previousState: AgentCredential['state']
  /** The classification's sentence. Never material; see `classify.ts`. */
  readonly reason: string
  readonly at: Date
}

/**
 * How administrators are told (FR-056).
 *
 * A seam rather than a Slack client, for the reason `reconcile.ts` gives about its notifier: a job
 * holding a messenger is a job an outage in that messenger can fail, and the platform's account of
 * a credential's health must not depend on a network call to a third party succeeding. One method,
 * because there is one transition here worth an alert — see the module note.
 */
export interface CredentialAlerter {
  readonly credentialUnhealthy: (alert: UnhealthyCredentialAlert) => Promise<void>
}

export interface ApplyHealthVerdictOptions {
  /** A pooled handle, not a transaction: this opens its own. */
  readonly db: SisyphusDatabase
  readonly agentCredentialId: string
  readonly verdict: HealthVerdict
  /**
   * Told when, and only when, a credential becomes unhealthy. Optional: a caller with none still
   * transitions the credential, and the state change is the part that must not depend on anything
   * external being reachable.
   */
  readonly alerter?: CredentialAlerter
  /** Injectable clock, so a test can state the instant a transition was recorded at. */
  readonly now?: Date
}

/** The credential moved, and the trail says so. */
export interface AppliedTransition {
  readonly outcome: 'changed'
  readonly agentCredentialId: string
  readonly from: AgentCredential['state']
  readonly to: AgentCredential['state']
  /** The provider's stated return time, where there was one (FR-078). */
  readonly coolingOffUntil: Date | undefined
  /** True only when an alerter was given *and* the destination was `unhealthy`. */
  readonly alerted: boolean
  /**
   * The alert that could not be handed off, if there was one.
   *
   * Reported rather than raised, exactly as `reconcile.ts` reports a notification it could not
   * send: the credential really is unhealthy and really is out of the pool, and turning an
   * unreachable Slack into a failed transition would leave the row saying the credential was fine.
   */
  readonly alertError: Error | undefined
}

/**
 * Nothing was written, because the row was not in a state a verdict may be applied from.
 *
 * Not an error. A verdict arriving for a credential an administrator has just disabled, or for one
 * already known to be broken, is an ordinary race between a slow provider response and somebody
 * acting — and the right answer is to leave the row alone and say so.
 */
export interface UnchangedTransition {
  readonly outcome: 'unchanged'
  readonly agentCredentialId: string
  /** What the row actually said, or `undefined` if there is no such credential. */
  readonly state: AgentCredential['state'] | undefined
}

export type HealthTransitionOutcome = AppliedTransition | UnchangedTransition

/**
 * What the transaction hands back, before the alert has been attempted.
 *
 * The credential's name travels out of the transaction because the alert wants it and reading it
 * again afterwards would be a second query for a value that was already in hand — and a value that
 * could have changed in between, which would put a different name in the alert than in the trail.
 */
interface CommittedTransition {
  readonly outcome: 'changed'
  readonly agentCredentialId: string
  readonly from: AgentCredential['state']
  readonly to: AgentCredential['state']
  readonly coolingOffUntil: Date | undefined
  readonly credentialName: string
}

/** See `allocate/select.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** Coerce an unknown thrown value into an `Error` without losing its content. */
const toError = (thrown: unknown): Error =>
  thrown instanceof Error ? thrown : new Error(String(thrown))

/**
 * Move a credential to where a provider's response says it belongs.
 *
 * The write is a conditional `UPDATE … WHERE id = :id AND state IN (…)`, the same shape
 * `acquire.ts` claims a seat with and for the same reason: zero rows affected is the answer, not a
 * failure, and it means somebody changed the row while this verdict was in flight.
 *
 * @param options - The handle, the credential, the verdict, and optionally an alerter and a clock.
 * @returns What changed, or {@link UnchangedTransition} when the row was not eligible.
 * @throws If the database refuses the write. A caller seeing a throw is looking at a broken
 *   database, not at a credential whose state is in doubt.
 */
export const applyHealthVerdict = async (
  options: ApplyHealthVerdictOptions,
): Promise<HealthTransitionOutcome> => {
  const { agentCredentialId, db, verdict } = options
  const now = options.now ?? new Date()

  const transition = await db.transaction(async (tx) => {
    const before = firstRow(
      await tx
        .select({ state: agentCredentials.state, name: agentCredentials.name })
        .from(agentCredentials)
        .where(eq(agentCredentials.id, agentCredentialId))
        .for('update'),
    )

    if (
      before === undefined ||
      !(VERDICT_SOURCE_STATES as readonly string[]).includes(before.state)
    ) {
      return {
        outcome: 'unchanged',
        agentCredentialId,
        state: before?.state,
      } satisfies UnchangedTransition
    }

    await tx
      .update(agentCredentials)
      .set({
        state: verdict.state,
        // Null on `unhealthy` by construction — `classify.ts` never states a return time for a
        // broken login — and null on a limit the provider gave no time for, which is FR-078's
        // case and is read by the sweep as "retry on the configured interval".
        coolingOffUntil: verdict.coolingOffUntil ?? null,
        // Written for both destinations. The column's name says unhealthy and its job is wider: an
        // administrator looking at a cooling-off seat in the pool view needs to know which limit it
        // hit, and the sentence is composed rather than quoted so it cannot carry material.
        lastFailureReason: verdict.reason,
      })
      .where(
        and(
          eq(agentCredentials.id, agentCredentialId),
          inArray(agentCredentials.state, [...VERDICT_SOURCE_STATES]),
        ),
      )

    // Inside the transaction, so a rolled-back transition cannot leave a trail claiming it
    // happened. Both states named: see the module note on why the `from` is the legible half.
    await tx.insert(configurationAudit).values({
      actorUserId: null,
      entityType: 'agent_credential',
      entityId: agentCredentialId,
      action: 'state_changed',
      detail: {
        from: before.state,
        to: verdict.state,
        signal: verdict.signal,
        reason: verdict.reason,
        coolingOffUntil: verdict.coolingOffUntil?.toISOString() ?? null,
      },
    })

    return {
      outcome: 'changed',
      agentCredentialId,
      from: before.state,
      to: verdict.state,
      coolingOffUntil: verdict.coolingOffUntil,
      credentialName: before.name,
    } satisfies CommittedTransition
  })

  if (transition.outcome === 'unchanged') {
    return transition
  }

  const applied: AppliedTransition = {
    outcome: 'changed',
    agentCredentialId,
    from: transition.from,
    to: transition.to,
    coolingOffUntil: transition.coolingOffUntil,
    alerted: false,
    alertError: undefined,
  }

  // Outside the transaction, and only for `unhealthy` (FR-037, SC-019). A network round trip inside
  // a row lock would hold the lock for the length of somebody else's outage.
  if (verdict.state !== 'unhealthy' || options.alerter === undefined) {
    return applied
  }

  try {
    await options.alerter.credentialUnhealthy({
      agentCredentialId,
      credentialName: transition.credentialName,
      previousState: transition.from,
      reason: verdict.reason,
      at: now,
    })
    return { ...applied, alerted: true }
  } catch (thrown) {
    return { ...applied, alertError: toError(thrown) }
  }
}

export interface ReturnFromCoolingOffOptions {
  readonly db: SisyphusDatabase
  readonly agentCredentialId: string
  /** Why the sweep decided the limit had cleared, for the trail. */
  readonly reason: string
}

/**
 * Put a cooling-off credential back in the pool (FR-076, FR-078, SC-019).
 *
 * The other direction through this module, and it is here rather than in the sweep that calls it
 * for the reason the module note gives: every credential state change writes one `state_changed`
 * entry with one shape, and a sweep that wrote its own would be the second definition of what a
 * transition looks like.
 *
 * **It returns to `available` only if nobody is holding it.** A credential that cooled off *while a
 * run held it* is still that run's — FR-023 forbids substituting another, FR-077 has the run wait
 * the limit out, and nothing released the lease — so it goes back to `held`, not to the pool. The
 * decision is read off `held_by`, which is precisely why `applyHealthVerdict` leaves that column
 * alone: it is the record of who is on the seat, and it survives the round trip through
 * `cooling_off` so the way back can be computed rather than guessed.
 *
 * Returning it to `available` instead would be the worst bug available in this file. The row would
 * say free while a live lease named it — the drift `credential_leases_live_key` exists to catch and
 * the FR-022 sweep exists to repair — and in the window before either did, selection would offer
 * one agent identity to a second workflow while the first was still authenticated as it. That is
 * SC-003, and it would be lost not to a race but to a sweep tidying up.
 *
 * **`last_failure_reason` is cleared.** The reason described a limit that has now cleared, and a
 * credential sitting in the pool showing "rate limited" against an `available` state is a screen
 * that contradicts itself. The trail keeps the history; the row carries the present.
 *
 * Conditional on `state = 'cooling_off'`, so a credential disabled, or claimed, while the sweep was
 * running is left where it is and reported {@link UnchangedTransition}.
 *
 * @param options - The handle, the credential, and why the sweep acted.
 * @returns The transition, naming where the credential actually went, or
 *   {@link UnchangedTransition} if the row had moved on.
 */
export const returnFromCoolingOff = async (
  options: ReturnFromCoolingOffOptions,
): Promise<HealthTransitionOutcome> => {
  const { agentCredentialId, db, reason } = options

  return db.transaction(async (tx) => {
    const updated = firstRow(
      await tx
        .update(agentCredentials)
        .set({
          // Back to the pool only if nobody is on the seat. A run that waited out the limit still
          // holds this credential, and `held_by` is the record of that — see the note above for
          // what returning it to `available` underneath a live lease would cost.
          state: sql`case when ${agentCredentials.heldBy} is null then 'available'::credential_state else 'held'::credential_state end`,
          coolingOffUntil: null,
          lastFailureReason: null,
        })
        .where(
          and(
            eq(agentCredentials.id, agentCredentialId),
            eq(agentCredentials.state, 'cooling_off'),
          ),
        )
        .returning({ state: agentCredentials.state }),
    )

    if (updated === undefined) {
      const current = firstRow(
        await tx
          .select({ state: agentCredentials.state })
          .from(agentCredentials)
          .where(eq(agentCredentials.id, agentCredentialId)),
      )

      return {
        outcome: 'unchanged',
        agentCredentialId,
        state: current?.state,
      } satisfies UnchangedTransition
    }

    await tx.insert(configurationAudit).values({
      actorUserId: null,
      entityType: 'agent_credential',
      entityId: agentCredentialId,
      action: 'state_changed',
      detail: { from: 'cooling_off', to: updated.state, reason },
    })

    return {
      outcome: 'changed',
      agentCredentialId,
      from: 'cooling_off',
      to: updated.state,
      coolingOffUntil: undefined,
      // Nothing is raised when a credential returns by itself, for the same reason nothing was
      // raised when it left (SC-019).
      alerted: false,
      alertError: undefined,
    } satisfies AppliedTransition
  })
}
