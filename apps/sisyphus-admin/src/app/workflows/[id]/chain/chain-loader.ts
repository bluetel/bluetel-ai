import type {
  ChainLoader,
  ChainMember,
  ChainMemberReader,
  LoadedChain,
} from '@sisyphus-admin/components/workflows/chain'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * **The chain loader backed by `workflow.chain` (T102, FR-152, FR-190).**
 *
 * `WorkflowChainView` takes a loader because two of them are possible and they are not equivalent.
 * The default — {@link import('@sisyphus-admin/components/workflows/chain').walkPredecessors} — walks
 * backwards over `workflow.byId`, which is genuinely all that procedure can support: finding the run
 * that *continues* a given one is a reverse lookup on `predecessor_workflow_id`, and nothing the
 * panel could reach offered one. Now that `workflow.chain` is mounted, this is the loader that makes
 * **both** directions real, which is what FR-152 asks for.
 *
 * ## Why this still reads each member through `workflow.byId`
 *
 * `workflow.chain` answers with `ChainLink`, and the panel renders `ChainMember`. The two agree on
 * everything except `updatedAt`, which `ChainLink` does not carry and which `chainStateReadout`
 * needs to say how long a live run has been going before the browser has a clock. Rather than have
 * this file invent a value for it — `createdAt` would make every live run read as `0:00` on first
 * paint — the chain procedure supplies **membership and direction**, and each member is then read
 * through the same projection the backwards walk uses. Those reads go through `api.useUtils()`, so
 * they are cached and deduplicated: the run whose page this is has usually been fetched already, and
 * a chain is a handful of runs, bounded at 64 by the server's own walk.
 *
 * ## Completeness is claimed only when it was established
 *
 * The server's forward walk is exhaustive, so a chain read whole means "nothing continues the last
 * run" is a fact rather than an absence — and the panel may say so. If any member could not be read
 * back, both directions are reported as unestablished and the panel keeps its "not established from
 * this view" wording. A card that claimed the end of a chain it had not actually reached would be
 * making a claim nobody checked, which is the thing that wording exists to avoid.
 *
 * A run outside the caller's scope is refused by `workflow.chain` exactly as `workflow.byId` refuses
 * it, so a rejection becomes an empty chain here and the panel renders "no such run" — the two are
 * one answer by design (FR-190).
 */

/** The chain as `workflow.chain` returns it. Never a hand-written mirror of `SuccessorChain`. */
export type SuccessorChainResult = RouterOutputs['workflow']['chain']

/** One scoped read of a whole chain. Rejects for a run that is absent or out of scope. */
export type ChainReader = (workflowId: string) => Promise<SuccessorChainResult>

export interface ChainLoaderOptions {
  /** `workflow.chain` — membership, ordering, and the forward direction. */
  readonly readChain: ChainReader
  /** `workflow.byId`, projected. `undefined` for a run that is absent or out of scope. */
  readonly readMember: ChainMemberReader
}

/** Nothing readable: the run itself is absent, or outside the caller's scope (FR-190). */
const EMPTY: LoadedChain = {
  members: [],
  completeness: { reachedRoot: false, reachedLatest: false },
}

/**
 * The oldest link, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this project, so `links[0]` is typed as present even for an
 * empty array and a `=== undefined` guard is narrowed away as unreachable. Going through a function
 * whose declared return type admits `undefined` restores the check — the same shape `firstRow` has
 * in `server/workflow/successor.ts`.
 */
const firstLink = (
  links: SuccessorChainResult['links'],
): SuccessorChainResult['links'][number] | undefined => links[0]

/**
 * Build the loader `WorkflowChainView` is handed.
 *
 * @param options - See {@link ChainLoaderOptions}.
 */
export const createChainLoader =
  (options: ChainLoaderOptions): ChainLoader =>
  async (workflowId) => {
    const chain = await options.readChain(workflowId).catch(() => undefined)

    if (chain === undefined || chain.links.length === 0) {
      return EMPTY
    }

    const resolved = await Promise.all(
      chain.links.map(async (link) => options.readMember(link.workflowId)),
    )
    const members = resolved.filter((member): member is ChainMember => member !== undefined)
    const oldest = firstLink(chain.links)
    const whole = members.length === chain.links.length && oldest !== undefined

    return {
      members,
      completeness: {
        reachedRoot: whole && oldest.predecessorWorkflowId === null,
        // The server walks forward until nothing continues the last run, so a chain read whole is
        // known in both directions — the half `walkPredecessors` can never establish.
        reachedLatest: whole,
      },
    }
  }
