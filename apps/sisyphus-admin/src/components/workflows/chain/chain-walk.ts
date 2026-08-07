import type { ChainMember } from './chain-model'

/**
 * **Assembling a chain from the procedures that exist (T102, FR-152, FR-190).**
 *
 * The chain the panel renders comes from a {@link ChainLoader}. Two implementations are relevant
 * and they are not equivalent:
 *
 * 1. **`workflow.chain`** — the server-side walk in `server/workflow/successor.ts`, which does both
 *    directions in one scoped query set and is the one FR-152 is written against. Wiring it is a
 *    one-line loader that calls the procedure.
 * 2. **{@link walkPredecessors}** — the client-side walk over `workflow.byId`, used here until that
 *    procedure is mounted. It follows `predecessorWorkflowId` backwards, which is genuinely all
 *    that `byId` can support: finding the run that *continues* a given one is a reverse lookup on a
 *    column, and no mounted procedure offers one.
 *
 * The distinction is stated rather than hidden because it changes what the panel can show. Opened
 * on the newest run of a chain, the backwards walk yields the whole chain and every row navigates
 * both ways. Opened on an earlier run, it yields that run and its ancestors, and
 * {@link ChainCompleteness} says so — `partial`, with the direction that is missing named, rather
 * than an empty space a reader would take to mean "nothing continued this".
 *
 * Every hop is a separate scoped read, so a run the caller may not see ends the walk exactly as it
 * ends the server's: absent, not named, not counted (FR-190).
 */

/** How far the walk follows a chain before treating it as a fault rather than a chain. */
export const MAX_CHAIN_WALK = 64

/** One scoped read of a run, as `workflow.byId` provides. `undefined` for out of scope or absent. */
export type ChainMemberReader = (workflowId: string) => Promise<ChainMember | undefined>

/** Which directions the assembled chain is known to be complete in. */
export interface ChainCompleteness {
  /** True when the walk reached a run that continues nothing — the root is in the set. */
  readonly reachedRoot: boolean
  /**
   * True when the set is known to contain every successor.
   *
   * False for the backwards walk unless the requested run is the one it started from *and* nothing
   * could continue it — which cannot be established without a reverse lookup, so it is false
   * whenever the loader cannot look forwards at all.
   */
  readonly reachedLatest: boolean
}

export interface LoadedChain {
  readonly members: readonly ChainMember[]
  readonly completeness: ChainCompleteness
}

/** What the panel is given. Async, and free to be a procedure call or a walk. */
export type ChainLoader = (workflowId: string) => Promise<LoadedChain>

/**
 * Walk backwards from a run to the root of its chain.
 *
 * @param read - One scoped read per hop.
 * @param workflowId - The run whose page this is.
 * @returns The requested run and every visible ancestor, oldest first, with the forward direction
 *   reported as unknown — see the module comment.
 */
export const walkPredecessors = async (
  read: ChainMemberReader,
  workflowId: string,
): Promise<LoadedChain> => {
  const requested = await read(workflowId)

  if (requested === undefined) {
    return { members: [], completeness: { reachedRoot: false, reachedLatest: false } }
  }

  const members: ChainMember[] = [requested]
  const seen = new Set<string>([requested.workflowId])
  let cursor = requested.predecessorWorkflowId
  let reachedRoot = requested.predecessorWorkflowId === null

  while (cursor !== null && members.length < MAX_CHAIN_WALK && !seen.has(cursor)) {
    const previous = await read(cursor)

    if (previous === undefined) {
      // Out of scope, or gone. The walk stops here rather than skipping over it: stepping over an
      // invisible run would disclose that something sits between two visible ones (FR-190).
      break
    }

    seen.add(previous.workflowId)
    members.unshift(previous)
    reachedRoot = previous.predecessorWorkflowId === null
    cursor = previous.predecessorWorkflowId
  }

  return { members, completeness: { reachedRoot, reachedLatest: false } }
}
