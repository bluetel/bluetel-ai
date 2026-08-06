/**
 * Naming an action taken against somebody else's system, so a retry cannot perform it twice
 * (FR-076, FR-077).
 *
 * ## Why this lives in `contracts` rather than in one consumer
 *
 * Two places in the platform perform external actions: the executor's delivery path opens pull
 * requests, and an integration package comments on tickets. Both need the *same* property — an
 * identity for an action that is reproduced exactly by a retry — and two hand-rolled versions of
 * it is how one of them ends up missing a case. `apps/sisyphus-executor/src/delivery/external-action.ts`
 * documents the mechanism in full and owns the perform/replay loop; what is shared, and therefore
 * what belongs here, is the *key*: the string both sides agree names one action.
 *
 * The key format is byte-for-byte the executor's, asserted in `external-action.test.ts` against
 * the pull-request example, so an integration package's comment key and the executor's pull
 * request key are the same scheme rather than two schemes that happen to resemble each other.
 *
 * ## The key is derived, never generated
 *
 * That is the whole property. A retry that generated a fresh key would be indistinguishable from
 * a new request, which is the duplicate FR-077 exists to prevent. So the key is built from what
 * the action *is*: the run it belongs to, the kind of action, and what it acts on.
 *
 * Two rules carry over to every caller, both learned from what a duplicate comment on a
 * customer's ticket costs:
 *
 * - **The target must include what the action is *for***, not only what it is on. A run comments
 *   on one ticket more than once, and an identity built from the ticket alone would let the first
 *   comment through and silently swallow every one after it as a replay.
 * - **The rendered text must never be in the key.** A retry that rendered a marginally different
 *   body — a timestamp, a re-ordered list — has to be the same action, or the duplicate walks
 *   straight back in through the one thing most likely to vary.
 */

/** Separates the parts of a key. Matches the executor's delivery path exactly. */
export const EXTERNAL_ACTION_KEY_SEPARATOR = ':'

/**
 * The run component for an action that belongs to no workflow.
 *
 * A skip comment (FR-143) is the case: the platform is saying *why it did not start a run*, so
 * there is no run to name. A sentinel rather than an optional field, because the alternative —
 * keying a skip by the tick that produced it — would post the same explanation on the same ticket
 * on every tick, which is the spam FR-143 does not ask for. One skip of a given reason on a given
 * item is one comment, for as long as that item exists.
 */
export const NO_WORKFLOW = 'no-workflow'

/**
 * What names one external action, uniquely and reproducibly.
 *
 * - `action` — what kind of thing this is, so a comment and a transition on the same ticket are
 *   different actions rather than one action performed twice.
 * - `workflowId` — the run, or {@link NO_WORKFLOW} where there is none.
 * - `target` — what it acts on, ordered. Whatever distinguishes this action from every other of
 *   the same kind in the same run: the branch pair for a pull request, the item and the purpose
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

/** How a result was arrived at. Recorded, because the two mean different things afterwards. */
export type ExternalActionDisposition =
  /** This attempt performed it. The only one that changed anything outside the platform. */
  | 'performed'
  /** The remote already held it: a previous attempt landed, or something else got there first. */
  | 'already-performed'

/** What a connector reports about one action it was asked to take. */
export interface ExternalActionResult {
  /** The derived key, so a caller can record what was done without rebuilding it. */
  readonly key: string
  readonly disposition: ExternalActionDisposition
  /** The remote's identifier for the thing that now exists — a comment id, say. */
  readonly reference: string
}
