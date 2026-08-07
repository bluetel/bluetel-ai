/**
 * Idempotent external actions (T087, FR-076, FR-077).
 *
 * ## The failure this exists to prevent
 *
 * A comment is posted on a customer's Jira ticket. The remote accepts it, and the connection dies
 * before the response arrives. The executor cannot tell that from a request the remote never saw,
 * so FR-047 has it retry — and the customer now has two identical comments from an automated
 * system on their ticket. The same shape opens two pull requests for one run.
 *
 * There is no way to make "post a comment" atomic across a network, so the fix is not to try. It
 * is to make the *identity* of the action something both sides can agree on, and to look before
 * creating — including after a failure, because a failed attempt is precisely the case where the
 * remote may already hold the result.
 *
 * ## The key is derived, never generated
 *
 * That is the whole property. A retry that generated a fresh key would be indistinguishable from a
 * new request, which is the duplicate FR-077 exists to prevent. So a key is built from what the
 * action *is*: the run it belongs to, the kind of action, and what it acts on. The same action
 * retried produces the same key on every attempt; a genuinely different action cannot collide with
 * it, because the parts that differ are in the key.
 *
 * ## Why this is general rather than a second bespoke mechanism
 *
 * `./pull-request.ts` already does the look-before-create half against the {@link Forge} port, and
 * `packages/sisyphus-integration-jira` needs the same guarantee for ticket comments. Two
 * hand-rolled versions of "check, then create, and hope" is how one of them ends up missing the
 * post-failure recheck. {@link externalActionKey} produces byte-for-byte the same string as
 * {@link import('./forge').pullRequestIdempotencyKey} for a pull request — asserted in
 * `external-action.test.ts` — so the existing delivery path is a special case of this one rather
 * than a competitor to it.
 *
 * ## The two halves, and which one is the guarantee (T180, T182-follow-up)
 *
 * There are two ledgers here and only one of them is a guarantee.
 *
 * The **in-memory** one is a `Map`. It is a fast path and nothing more: a retry inside one process
 * replays without a round trip. It is per-process and empty after a re-provision, so an instance
 * reclaimed mid-delivery and replaced comes back knowing nothing — which was the whole of FR-076's
 * durability requirement going unmet while this file's own comment conceded it.
 *
 * The **durable** one is `external_actions` on the machine surface, reached through
 * {@link ExternalActionRecorder} and keyed by exactly the string {@link externalActionKey} derives.
 * Its unique index on `(workflow_id, kind, idempotency_key)` is what makes the action exactly-once
 * *across processes*, and the protocol is a claim rather than a log:
 *
 * 1. Report the action as `pending` **before** performing it. Exactly one caller's insert wins the
 *    index and comes back `claimed: true`.
 * 2. `claimed && !alreadyPerformed` is the entitlement to act, and the only one.
 * 3. Report `succeeded` or `failed` afterwards. `succeeded` is terminal on the row: a retry
 *    reporting a failure over it is the lost-response case, not a reversal.
 *
 * A caller that is **not** entitled does not perform and does not pretend it did — it throws
 * {@link ExternalActionNotEntitledError}, naming which of the two reasons applies. A ledger built
 * without a recorder keeps the old behaviour exactly, which is what makes this safe to adopt one
 * call site at a time; {@link ExternalActionLedger.isDurable} is how a caller can tell which kind
 * it is holding rather than assuming.
 *
 * ## What this does not do
 *
 * It does not retry. The schedule is `../report/backoff.ts`'s and the loop belongs to whoever owns
 * it; this is what makes that loop safe to run. It also does not decide when to give up — but it
 * does keep the record FR-076 asks for on the way out, so a halt after exhaustion can name the
 * action that was left pending. See {@link pendingExternalActions}.
 */

import type { ExternalActionClaim, ExternalActionInput } from '../report'

/** Separates the parts of a key. Chosen to match the pull-request key that predates this module. */
export const EXTERNAL_ACTION_KEY_SEPARATOR = ':'

/**
 * Opening a pull request for a run's work branch (FR-060, FR-077).
 *
 * The only action name this directory defines, and deliberately so. Ticket comments and ticket
 * transitions are the other things FR-077 covers, and they belong to
 * `packages/sisyphus-integration-jira` — which names them itself and builds their identities with
 * {@link externalActionKey}. That is not tidiness: FR-060 leaves delivery ownership with the
 * initiating engineer, and `index.test.ts` holds the delivery barrel to exporting **nothing** that
 * so much as names a ticket transition. A key builder cannot transition anything, but putting the
 * word here would make an absence that is currently structural into one that is merely observed.
 */
export const PULL_REQUEST_ACTION = 'pull-request'

/**
 * What names one external action, uniquely and reproducibly.
 *
 * Three parts, and each is load-bearing:
 *
 * - `action` — what kind of thing this is, so a comment and a transition on the same ticket are
 *   different actions rather than one action performed twice.
 * - `workflowId` — the run. Two runs proposing the same branch onto the same base are two
 *   different pull requests, and a key that omitted the run would suppress the second one.
 * - `target` — what it acts on, ordered. Whatever distinguishes this action from every other of
 *   the same kind in the same run: the branch pair for a pull request, the ticket and the reason
 *   for a comment.
 */
export interface ExternalActionIdentity {
  readonly action: string
  readonly workflowId: string
  readonly target: readonly string[]
  /**
   * Which of the platform's four recorded kinds this is, for the durable row (FR-076).
   *
   * Inferred from the machine surface rather than restated, and **required**: the durable ledger's
   * unique index is scoped by kind, so an action with no kind is an action that cannot be claimed.
   * Making it optional would have let a call site opt out of the guarantee by omission, which is
   * the failure mode this whole change exists to close.
   *
   * It is not the same thing as `action`. `action` is what the executor calls the step and is part
   * of the key; `kind` is the platform's vocabulary for what a customer will see. Two integration
   * steps and a pull request are all `branch_pushed`-shaped writes to the same enum, and they stay
   * distinct because their keys differ, not because their kinds do.
   */
  readonly kind: DurableExternalActionKind
}

/** The platform's vocabulary for an external action, inferred from the machine surface. */
export type DurableExternalActionKind = ExternalActionInput['kind']

/** How far a durable row has got. */
export type DurableExternalActionResult = ExternalActionInput['result']

/**
 * **The durable ledger, as the one method this module needs from it.**
 *
 * `MachineSurfaceClient` satisfies it structurally, so a caller passes the client it already has
 * and this module never learns what a tRPC client is — the same seam discipline `SnapshotPort`
 * applies to `session/suspend.ts`.
 */
export interface ExternalActionRecorder {
  readonly reportExternalAction: (input: ExternalActionInput) => Promise<ExternalActionClaim>
}

/** Why a caller may not perform an action it was asked to perform. */
export type ExternalActionRefusal =
  /** The durable row says it already landed. Nobody may do it again, in any process. */
  | 'already-performed'
  /** Another attempt holds the claim and has not reported how it went. */
  | 'claim-held-elsewhere'

/**
 * The refusal, as an error rather than a silent no-op (FR-076, FR-077).
 *
 * Throwing is the conservative answer and it is chosen deliberately. The alternative — returning
 * some placeholder result — would require inventing a `TResult` this process does not have, and
 * the caller would carry on as though a comment it never saw had been posted. A throw is caught by
 * the delivery step's own error handling, which records the step as unfinished and names the
 * reason; a retry later finds the row `succeeded` and the remote holding the result, and replays
 * through {@link ExternalAction.find} instead.
 */
export class ExternalActionNotEntitledError extends Error {
  readonly key: string
  readonly refusal: ExternalActionRefusal

  constructor(options: { readonly key: string; readonly refusal: ExternalActionRefusal }) {
    super(
      options.refusal === 'already-performed'
        ? `the durable external-action ledger records ${options.key} as already performed, and ` +
            'the remote could not be asked for what it produced. Nothing was attempted: ' +
            'performing it again is the duplicate FR-077 exists to prevent'
        : `another attempt holds the claim on ${options.key} and has not reported how it went, ` +
            'so this one is not entitled to act. Nothing was attempted',
    )
    this.name = 'ExternalActionNotEntitledError'
    this.key = options.key
    this.refusal = options.refusal
  }
}

/**
 * The key for one action.
 *
 * @param identity - What the action is, what run it belongs to, and what it acts on.
 * @returns A key that is the same on every attempt of this action and different for any other.
 */
export const externalActionKey = (identity: ExternalActionIdentity): string =>
  [identity.action, identity.workflowId, ...identity.target].join(EXTERNAL_ACTION_KEY_SEPARATOR)

/**
 * The identity of a run's pull request from one branch onto another.
 *
 * @param input - The run and the branch pair the pull request proposes.
 */
export const pullRequestIdentity = (input: {
  readonly workflowId: string
  readonly repository: string
  readonly head: string
  readonly base: string
}): ExternalActionIdentity => ({
  action: PULL_REQUEST_ACTION,
  workflowId: input.workflowId,
  target: [input.repository, input.head, input.base],
  kind: 'pull_request_opened',
})

/**
 * What the durable row records as the thing acted on.
 *
 * The target parts, joined — the repository and branch pair for a pull request, the ticket and the
 * state for a transition. Not the key: the key is unique and machine-facing, and this column is
 * what somebody reads in a list of what a run did outside the platform. It falls back to the
 * action name for the degenerate empty target, because the column is `not null` and a row that
 * cannot be written is worse than a row that names less than it might.
 *
 * @param identity - What the action is and what it acts on.
 */
export const externalActionTargetReference = (identity: ExternalActionIdentity): string =>
  identity.target.join(EXTERNAL_ACTION_KEY_SEPARATOR) || identity.action

/**
 * ## Naming a comment, for the integration package that will post one
 *
 * `packages/sisyphus-integration-jira` builds its identities the same way — an action name of its
 * own, the run, and a target — and two rules carry over, both learned from what a duplicate
 * comment costs:
 *
 * - **The target must include what the comment is *for***, not only which ticket it is on. A run
 *   posts more than once, and a comment identified by its ticket alone would let the first through
 *   and silently swallow every one after it as a replay.
 * - **The comment's text must not be in the key.** A retry that rendered a marginally different
 *   body — a timestamp, a re-ordered list — has to be the same action, or the duplicate this
 *   module exists to prevent walks straight back in through the one thing most likely to vary.
 */

/** How a result was arrived at. Recorded, because the three mean different things afterwards. */
export type ExternalActionDisposition =
  /** This attempt performed it. The only one that changed anything outside the platform. */
  | 'performed'
  /** The remote already held it: a previous attempt landed, or something else got there first. */
  | 'already-performed'
  /** This process had already recorded a result for the key and did not ask the remote again. */
  | 'replayed'

/** What the ledger knows about one action. */
export interface ExternalActionEntry<TResult> {
  readonly key: string
  /** Attempts made through {@link performExternalAction}, including the ones that threw. */
  readonly attempts: number
  /** Present once the action is known to have happened. Absent means still pending. */
  readonly result?: TResult
}

/** Whether this attempt may perform the action, and why not when it may not. */
export interface ExternalActionEntitlement {
  readonly entitled: boolean
  /** Absent when entitled. */
  readonly refusal?: ExternalActionRefusal
  /** False for a ledger with no recorder — the answer was assumed, not established. */
  readonly durable: boolean
}

/**
 * Where results are remembered — for the life of the run, and beyond it.
 *
 * The `Map` is the fast path: a retry inside one process replays without a round trip. The
 * guarantee is {@link ExternalActionLedger.claim} and {@link ExternalActionLedger.settle}, which
 * go to `external_actions` through the injected {@link ExternalActionRecorder} and survive a
 * re-provision because they are a row rather than a map. See the module comment for the protocol
 * and for why the key is derived rather than generated.
 */
export interface ExternalActionLedger<TResult> {
  readonly entryFor: (key: string) => ExternalActionEntry<TResult> | undefined
  readonly record: (entry: ExternalActionEntry<TResult>) => void
  /** Every action attempted, in the order first attempted. */
  readonly entries: () => readonly ExternalActionEntry<TResult>[]
  /**
   * False when this ledger has no recorder and is therefore a fast path with nothing behind it.
   *
   * Exposed so "is this run's exactly-once guarantee actually durable?" is a question with an
   * answer, rather than something inferred from how the ledger happened to be constructed.
   */
  readonly isDurable: boolean
  /**
   * Claim the right to perform this action, before performing it.
   *
   * @param identity - What the action is. The durable row is keyed on the same derived string.
   * @param attemptCount - This attempt's 1-based number, recorded on the row.
   */
  readonly claim: (
    identity: ExternalActionIdentity,
    attemptCount: number,
  ) => Promise<ExternalActionEntitlement>
  /**
   * Record how the attempt went, after performing it.
   *
   * @param identity - The same action.
   * @param attemptCount - The attempt being reported.
   * @param result - `succeeded`, which is terminal on the row, or `failed`.
   */
  readonly settle: (
    identity: ExternalActionIdentity,
    attemptCount: number,
    result: Exclude<DurableExternalActionResult, 'pending'>,
  ) => Promise<void>
}

export interface ExternalActionLedgerOptions {
  /**
   * The machine surface. Pass the run's `MachineSurfaceClient`.
   *
   * Optional only so a caller with genuinely nothing to record against — a unit test, a
   * call-local ledger that deduplicates within one invocation and claims nothing more — can say so
   * explicitly. Every ledger that outlives a single call should have one.
   */
  readonly recorder?: ExternalActionRecorder
}

/**
 * A ledger, durable when given a recorder and a fast path when not.
 *
 * @param options - The machine surface to claim against. See {@link ExternalActionLedgerOptions}.
 */
export const createExternalActionLedger = <TResult>(
  options: ExternalActionLedgerOptions = {},
): ExternalActionLedger<TResult> => {
  const entries = new Map<string, ExternalActionEntry<TResult>>()
  const recorder = options.recorder

  const report = async (
    identity: ExternalActionIdentity,
    attemptCount: number,
    result: DurableExternalActionResult,
  ): Promise<ExternalActionClaim | undefined> =>
    recorder?.reportExternalAction({
      kind: identity.kind,
      targetReference: externalActionTargetReference(identity),
      idempotencyKey: externalActionKey(identity),
      result,
      attemptCount,
    })

  return {
    isDurable: recorder !== undefined,
    entryFor: (key) => entries.get(key),
    record: (entry) => {
      entries.set(entry.key, entry)
    },
    entries: () => [...entries.values()],
    claim: async (identity, attemptCount) => {
      const claim = await report(identity, attemptCount, 'pending')

      if (claim === undefined) {
        // No recorder: the caller has said there is nothing to claim against, so the in-memory
        // path is all there is and this must not invent a refusal it has no basis for.
        return { entitled: true, durable: false }
      }

      if (claim.alreadyPerformed) {
        return { entitled: false, refusal: 'already-performed', durable: true }
      }

      return claim.claimed
        ? { entitled: true, durable: true }
        : { entitled: false, refusal: 'claim-held-elsewhere', durable: true }
    },
    settle: async (identity, attemptCount, result) => {
      await report(identity, attemptCount, result)
    },
  }
}

/**
 * Actions that were attempted and are not known to have landed.
 *
 * FR-076: on retry exhaustion the workflow halts **with the pending action recorded**. This is
 * that record — the keys, so the halt names what was left in the air rather than saying only that
 * something failed.
 *
 * @param ledger - The run's ledger.
 */
export const pendingExternalActions = <TResult>(
  ledger: ExternalActionLedger<TResult>,
): readonly ExternalActionEntry<TResult>[] =>
  ledger.entries().filter((entry) => entry.result === undefined)

/** One external action, expressed as the two questions this module needs to be able to ask. */
export interface ExternalAction<TResult> {
  readonly identity: ExternalActionIdentity

  /**
   * Ask the remote whether this action has already been performed, answering `undefined` if not.
   *
   * Optional, because not every remote can be asked — but supplying it is what closes the
   * timeout gap, so a port that *could* answer and does not is choosing to allow duplicates. The
   * {@link import('./forge').Forge} port exposes `findPullRequest` for precisely this.
   */
  readonly find?: () => Promise<TResult | undefined>

  /**
   * Perform it.
   *
   * The derived key is passed in rather than left for the caller to rebuild, so a remote that
   * honours idempotency keys of its own gets the same one this module is reasoning about. A remote
   * that ignores it is still covered, by {@link ExternalAction.find}.
   */
  readonly perform: (idempotencyKey: string) => Promise<TResult>
}

export interface ExternalActionOutcome<TResult> {
  readonly key: string
  readonly result: TResult
  readonly disposition: ExternalActionDisposition
  /** Attempts made across every call for this key, including the ones that threw. */
  readonly attempts: number
}

/**
 * Perform an external action at most once, however many times this is called — and however many
 * processes call it.
 *
 * Five steps, in this order. The fourth is the one a hand-rolled version forgets and the third is
 * the one that only became true when the durable ledger arrived:
 *
 * 1. **Replay.** A recorded result for this key is returned without asking anything. A retry
 *    inside one process costs nothing and cannot duplicate.
 * 2. **Look before creating.** Ask the remote. This is what catches a previous attempt that landed
 *    in an earlier call whose response was lost, and it is what recovers the *result* of that
 *    attempt — which the durable row cannot supply, because it records that an action happened and
 *    not what it produced. A lookup that *fails* is not a lookup that found nothing, so it
 *    propagates and nothing is created: treating "could not ask" as "not there" is exactly how the
 *    second comment gets posted.
 * 3. **Claim.** Report the action as `pending` on the machine surface and act only on
 *    `claimed && !alreadyPerformed`. This is the cross-process half: the remote lookup above
 *    cannot see an attempt that is *in flight* on another instance, and the unique index can.
 *    A refusal throws {@link ExternalActionNotEntitledError} and performs nothing.
 * 4. **Perform**, handing the remote the derived key.
 * 5. **Look again if it threw.** A failure is exactly the case where the remote may have accepted
 *    the request and the response never arrived — so before the error is allowed out, the remote
 *    is asked whether the action is there. If it is, the attempt *succeeded* and is reported as
 *    such; the caller's retry loop never runs, and no second comment is posted.
 *
 * Every path out that establishes what happened settles the durable row: `succeeded` for a landed
 * action, `failed` for one that threw and could not be found. A row left `pending` is the honest
 * record of an attempt whose fate this process never learned, which is what a later claim reads
 * as `claim-held-elsewhere`.
 *
 * The attempt is counted before the perform, so a throw leaves the count incremented and the entry
 * pending — which is what {@link pendingExternalActions} reports on a halt.
 *
 * @param ledger - The run's ledger. One per result type; typically one per delivery step.
 * @param action - What to do, how to recognise it having been done, and what it is.
 * @returns The result, and how it was arrived at.
 * @throws ExternalActionNotEntitledError when the durable ledger says this attempt may not act.
 * @throws Whatever `perform` threw, but only once the remote has been asked and does not have it.
 */
export const performExternalAction = async <TResult>(
  ledger: ExternalActionLedger<TResult>,
  action: ExternalAction<TResult>,
): Promise<ExternalActionOutcome<TResult>> => {
  const { identity } = action
  const key = externalActionKey(identity)
  const known = ledger.entryFor(key)

  if (known?.result !== undefined) {
    return { key, result: known.result, disposition: 'replayed', attempts: known.attempts }
  }

  const attempts = (known?.attempts ?? 0) + 1

  const settle = async (
    result: TResult,
    disposition: ExternalActionDisposition,
  ): Promise<ExternalActionOutcome<TResult>> => {
    ledger.record({ key, attempts, result })
    await ledger.settle(identity, attempts, 'succeeded')

    return { key, result, disposition, attempts }
  }

  // Asked before the attempt is counted: finding the action already there is not an attempt at
  // performing it, and counting it as one would overstate how hard the run pushed on the remote.
  const existing = await action.find?.()
  if (existing !== undefined) {
    const seen = known?.attempts ?? 0
    ledger.record({ key, attempts: seen, result: existing })
    // Recorded as landed even though this process did not land it: the row is about the action,
    // not about who performed it, and leaving it `pending` would have the next attempt read a
    // completed action as one still in flight.
    await ledger.settle(identity, Math.max(seen, 1), 'succeeded')

    return { key, result: existing, disposition: 'already-performed', attempts: seen }
  }

  // The cross-process gate. Nothing below this line runs for an attempt that did not win it.
  const entitlement = await ledger.claim(identity, attempts)

  if (!entitlement.entitled) {
    throw new ExternalActionNotEntitledError({
      key,
      refusal: entitlement.refusal ?? 'claim-held-elsewhere',
    })
  }

  ledger.record({ key, attempts })

  let performed: TResult
  try {
    performed = await action.perform(key)
  } catch (error) {
    // The timeout case. The request may have been accepted before the connection died, and the
    // caller is about to retry — so ask, and if the remote has it, this attempt succeeded.
    const landed = await action.find?.().catch(() => undefined)

    if (landed !== undefined) {
      return settle(landed, 'already-performed')
    }

    // Reported as failed, not left pending: this process knows how the attempt went, and a row
    // stuck on `pending` would make the retry look like a claim somebody else is still holding.
    await ledger.settle(identity, attempts, 'failed')

    throw error
  }

  return settle(performed, 'performed')
}
