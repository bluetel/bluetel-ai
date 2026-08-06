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
 * ## What this does not do
 *
 * It does not retry. The schedule is `../report/backoff.ts`'s and the loop belongs to whoever owns
 * it; this is what makes that loop safe to run. It also does not decide when to give up — but it
 * does keep the record FR-076 asks for on the way out, so a halt after exhaustion can name the
 * action that was left pending. See {@link pendingExternalActions}.
 */

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
})

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

/**
 * Where results are remembered for the life of the run.
 *
 * In memory, and that is the honest scope: the instance is the retry loop, and a replacement
 * instance is a re-provision with a fresh credential and a fresh run of the delivery path. The
 * durable half of FR-076 is `external_actions` on the machine surface, keyed by the same string —
 * which is why the key is derived rather than generated, and why nothing here is stateful in a way
 * that a restart would have to reconstruct.
 */
export interface ExternalActionLedger<TResult> {
  readonly entryFor: (key: string) => ExternalActionEntry<TResult> | undefined
  readonly record: (entry: ExternalActionEntry<TResult>) => void
  /** Every action attempted, in the order first attempted. */
  readonly entries: () => readonly ExternalActionEntry<TResult>[]
}

export const createExternalActionLedger = <TResult>(): ExternalActionLedger<TResult> => {
  const entries = new Map<string, ExternalActionEntry<TResult>>()

  return {
    entryFor: (key) => entries.get(key),
    record: (entry) => {
      entries.set(entry.key, entry)
    },
    entries: () => [...entries.values()],
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
 * Perform an external action at most once, however many times this is called.
 *
 * Four steps, in this order, and the last is the one a hand-rolled version forgets:
 *
 * 1. **Replay.** A recorded result for this key is returned without asking the remote anything. A
 *    retry inside one process costs nothing and cannot duplicate.
 * 2. **Look before creating.** Ask the remote. This is what catches a previous attempt that landed
 *    in an earlier call whose response was lost. A lookup that *fails* is not a lookup that found
 *    nothing, so it propagates and nothing is created: treating "could not ask" as "not there" is
 *    exactly how the second comment gets posted.
 * 3. **Perform**, handing the remote the derived key.
 * 4. **Look again if it threw.** A failure is exactly the case where the remote may have accepted
 *    the request and the response never arrived — so before the error is allowed out, the remote
 *    is asked whether the action is there. If it is, the attempt *succeeded* and is reported as
 *    such; the caller's retry loop never runs, and no second comment is posted.
 *
 * The attempt is counted before the perform, so a throw leaves the count incremented and the entry
 * pending — which is what {@link pendingExternalActions} reports on a halt.
 *
 * @param ledger - The run's ledger. One per result type; typically one per delivery step.
 * @param action - What to do, how to recognise it having been done, and what it is.
 * @returns The result, and how it was arrived at.
 * @throws Whatever `perform` threw, but only once the remote has been asked and does not have it.
 */
export const performExternalAction = async <TResult>(
  ledger: ExternalActionLedger<TResult>,
  action: ExternalAction<TResult>,
): Promise<ExternalActionOutcome<TResult>> => {
  const key = externalActionKey(action.identity)
  const known = ledger.entryFor(key)

  if (known?.result !== undefined) {
    return { key, result: known.result, disposition: 'replayed', attempts: known.attempts }
  }

  const attempts = (known?.attempts ?? 0) + 1

  const settle = (
    result: TResult,
    disposition: ExternalActionDisposition,
  ): ExternalActionOutcome<TResult> => {
    ledger.record({ key, attempts, result })
    return { key, result, disposition, attempts }
  }

  // Asked before the attempt is counted: finding the action already there is not an attempt at
  // performing it, and counting it as one would overstate how hard the run pushed on the remote.
  const existing = await action.find?.()
  if (existing !== undefined) {
    ledger.record({ key, attempts: known?.attempts ?? 0, result: existing })
    return {
      key,
      result: existing,
      disposition: 'already-performed',
      attempts: known?.attempts ?? 0,
    }
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

    throw error
  }

  return settle(performed, 'performed')
}
