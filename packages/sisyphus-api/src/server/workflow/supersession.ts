/**
 * **Which uncollected supervision command replaces which (T089, T090, SC-003).**
 *
 * The queue is polled, not pushed, so there is always a window between a user pressing a button and
 * the instance reading the row. Press two buttons inside that window and the executor collects two
 * live commands with no recorded relationship between them — it would pause, acknowledge, and only
 * then discover it had also been asked to stop. `supervision_delivery_outcome` carries `superseded`
 * for exactly this, and this module is where the rule lives that decides when to use it.
 *
 * Pure, and separated from the queue writer on purpose: the rule is small, entirely a matter of
 * judgement, and the failure mode when it is wrong is an instance doing something the user replaced.
 * It is asserted in `supersession.test.ts` without a database.
 *
 * ## The rule, stated once
 *
 * 1. **A `stop` cancels an uncollected `pause` or `resume`.** Once the run is being ended, pausing
 *    or resuming it is work nobody asked for. This is the case the contract names.
 * 2. **A `pause` and a `resume` cancel each other.** Pausing and immediately un-pausing before the
 *    instance noticed is one net no-op, and applying both would suspend a run the user has already
 *    decided to keep going.
 * 3. **A `stop` is final: nothing supersedes it, and anything arriving after it is itself
 *    superseded.** The alternative is a pause queued behind a stop, applied to an instance that is
 *    being torn down, and acknowledged as though it meant something. Ordering alone does not save
 *    this — the executor applies in `sequence` order, so the stop wins the race and the pause is
 *    still sitting there afterwards, pending forever against a run that no longer exists.
 *
 * Rule 3 is the one that is easy to get wrong in the other direction. Refusing the later `pause`
 * outright would be wrong too: a refusal is an error the user has to interpret, and what actually
 * happened is that their request was overtaken. `superseded` says that and is already in the
 * vocabulary.
 */

import type { supervisionCommandEnum } from '../../db'

/**
 * The three things a person can ask of a live run.
 *
 * Derived from the Postgres enum rather than restated, so a value cannot exist in the database and
 * not in the rule — the same discipline `db/schema/enums.ts` applies to the cross-cutting tuples.
 */
export type SupervisionCommandName = (typeof supervisionCommandEnum.enumValues)[number]

/** A queued command as far as the rule is concerned: what it is, and where it sits in the order. */
export interface UncollectedCommand {
  readonly id: string
  readonly command: SupervisionCommandName
  readonly sequence: number
}

/** What {@link resolveSupersession} decided. */
export interface SupersessionOutcome {
  /**
   * Ids of already-queued commands the incoming one replaces. Marked `superseded` in the same
   * transaction that writes the incoming row, so the executor cannot observe the two disagreeing.
   */
  readonly supersededIds: readonly string[]
  /**
   * True when the **incoming** command is the one that was overtaken — a `pause` arriving behind an
   * uncollected `stop`. It is still written, so the request is recorded rather than silently
   * discarded, but it is written already `superseded` and is never applied.
   */
  readonly incomingIsSuperseded: boolean
  /** Which command did the overtaking — the incoming one, or the `stop` that blocked it. */
  readonly supersededBy: SupervisionCommandName
  /** Written to `failure_reason` on every superseded row, so the queue explains itself. */
  readonly reason: string
}

/** The sentence the panel shows for a request that was overtaken before the instance saw it. */
export const supersededExplanation = (supersededBy: SupervisionCommandName): string =>
  `This request was overtaken by a ${supersededBy} that had not yet reached the instance, so it was recorded but never applied.`

/**
 * Decide what an incoming command does to the commands already queued and uncollected.
 *
 * @param uncollected - Commands the executor has not yet acknowledged, in any order.
 * @param incoming - The command being queued now.
 */
export const resolveSupersession = (
  uncollected: readonly UncollectedCommand[],
  incoming: SupervisionCommandName,
): SupersessionOutcome => {
  // Rule 3, checked first: a pending stop makes everything after it moot, including this.
  const blockingStop = uncollected.find((queued) => queued.command === 'stop')

  if (blockingStop !== undefined) {
    return {
      supersededIds: [],
      incomingIsSuperseded: true,
      supersededBy: 'stop',
      reason: supersededExplanation('stop'),
    }
  }

  // Rules 1 and 2 collapse into one statement, and that is not a shortcut. Everything still
  // uncollected here is a `pause` or a `resume` — a `stop` would have been caught above — and an
  // incoming command of any kind replaces every one of them: a stop makes them pointless, a resume
  // undoes a pause, a pause undoes a resume, and a second pause is the same pause. Writing the two
  // rules as separate branches with identical bodies would invite an edit to one of them.
  return {
    supersededIds: uncollected.map((queued) => queued.id),
    incomingIsSuperseded: false,
    supersededBy: incoming,
    reason: supersededExplanation(incoming),
  }
}

/**
 * Commands in the order the executor must apply them.
 *
 * `sequence` is the only ordering — never `created_at`, which is a clock, and never insertion order
 * from the driver, which is whatever the plan produced. The unique index on `(workflow_id,
 * sequence)` is what makes this total.
 *
 * @param commands - Any collection of queued commands.
 */
export const inSequenceOrder = <TCommand extends { readonly sequence: number }>(
  commands: readonly TCommand[],
): readonly TCommand[] => [...commands].sort((left, right) => left.sequence - right.sequence)
