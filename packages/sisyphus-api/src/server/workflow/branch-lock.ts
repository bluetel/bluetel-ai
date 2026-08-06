import { createHash } from 'node:crypto'

import { TRPCError } from '@trpc/server'
import { and, eq, ne, notInArray, or, sql } from 'drizzle-orm'

import type { SisyphusDatabase } from '../../db'
import { workflowEntries, workflows } from '../../db'
import type { WorkflowState } from '../../enums'
import { TERMINAL_WORKFLOW_STATES } from '../../enums'

/**
 * The cross-repository concurrency guard (T107, FR-120).
 *
 * "Two non-terminal workflows MUST NOT hold the same repository and branch concurrently, evaluated
 * across every entry of their workspaces; the conflict MUST be refused or serialised with the
 * holding workflow named."
 *
 * ## Why this is an advisory lock and not a constraint
 *
 * Every other invariant in this schema that matters is a database constraint, because a constraint
 * cannot be forgotten by a new caller. This one cannot be: the predicate is
 *
 *     workflow_entries(repository_url, base_branch) is unique **among workflows whose state is not
 *     terminal**
 *
 * and the state lives on `workflows`, a different table. A unique index on `workflow_entries` has
 * no access to it; a partial index needs its predicate in its own row; and the obvious workaround —
 * denormalising the state onto every entry — replaces one invariant with two that have to be kept
 * in step by exactly the application code the constraint was meant to be independent of.
 * `workflow_entries_repository_branch_idx` exists, and is documented in the schema as a **probe**
 * for finding the current holders cheaply, not as the enforcement.
 *
 * So the enforcement is a transaction-scoped Postgres advisory lock per `(repository_url,
 * base_branch)` pair, and it is the **sole** mechanism. Two properties follow, and both matter:
 *
 * - **A check-then-write cannot race it.** Between `select … where state not terminal` and the
 *   `insert`, another launcher can commit its own run; both would read no holder and both would
 *   write. Under the lock the second launcher blocks in the database until the first commits, and
 *   then reads the *committed* state — which is why the check happens after the lock and never
 *   before it.
 * - **It is released by the transaction, whatever happens to the process.** `pg_advisory_xact_lock`
 *   is dropped at commit or rollback, including when the backend dies. A session-level lock, or a
 *   row in a `locks` table, would need a reaper — and a launcher crashing between taking the lock
 *   and releasing it would wedge a repository until someone noticed.
 *
 * ## The keys are sorted, and that is not tidiness
 *
 * A workspace of several entries takes several locks. Two multi-repository workflows over the same
 * pair of repositories, launching at the same moment, in the order each workspace happens to
 * declare, is a textbook deadlock: A holds `api` and wants `web`, B holds `web` and wants `api`.
 * Postgres detects it after `deadlock_timeout` and kills one launch with an error nobody can act
 * on. {@link branchLockPairs} sorts by key and deduplicates, so every caller takes the same locks
 * in the same order and the cycle cannot form. `branch-lock.test.ts` proves both halves: that the
 * deadlock is real when the order is reversed, and that it does not happen through this module.
 *
 * ## Naming the holder
 *
 * FR-120 requires the refusal to name the holding workflow, so it does — the id, the repository and
 * the branch, and nothing else about the run. That is a deliberate line: the caller already knows
 * the repository, because it is in the workspace they are launching, and an opaque id is what lets
 * an administrator find the run. The owner, the ticket and the prompt are not disclosed, so a
 * caller learns that *a* run holds the branch, not whose it is.
 */

/** Distinguishes these locks from any other advisory lock the platform might take. */
export const BRANCH_LOCK_NAMESPACE = 'sisyphus:workflow-branch'

/** One repository and the branch a workflow would hold in it. */
export interface BranchLockPair {
  readonly repositoryUrl: string
  readonly baseBranch: string
}

/**
 * The 64-bit advisory-lock key for one pair, as a decimal string.
 *
 * Derived by hash rather than allocated, so it needs no table and no coordination: two processes
 * that have never met agree on the key for `(repo, branch)` because they compute it from the pair.
 *
 * The pair is used **verbatim**, trimmed and no more. It is tempting to normalise — lower-case the
 * host, strip a trailing `.git` — and it would be wrong here: {@link findBranchHolders} compares
 * the same two columns with `=`, so any normalisation the key applied and the query did not would
 * put two callers on one lock while the probe told them they were unrelated. The lock and the probe
 * must be about exactly the same strings.
 *
 * Returned as a string because the key is a signed 64-bit integer and JavaScript numbers are not.
 *
 * @param pair - The repository and branch.
 */
export const branchLockKey = (pair: BranchLockPair): string => {
  const digest = createHash('sha256')
    .update([BRANCH_LOCK_NAMESPACE, pair.repositoryUrl.trim(), pair.baseBranch.trim()].join('\n'))
    .digest()

  return digest.readBigInt64BE(0).toString()
}

/**
 * The pairs a workspace holds: deduplicated, and in one global order.
 *
 * Sorted by key rather than by name, because the key is what the database locks on and the order
 * has to be the same for every caller however it spells its repository URLs.
 *
 * @param pairs - Every entry of the workspace, in whatever order it declared them.
 */
export const branchLockPairs = (pairs: readonly BranchLockPair[]): readonly BranchLockPair[] => {
  const byKey = new Map<string, BranchLockPair>()

  for (const pair of pairs) {
    // First wins; two entries naming the same repository and branch are one lock, and taking it
    // twice in one transaction would be harmless but would make the ordering argument murkier.
    const key = branchLockKey(pair)

    if (!byKey.has(key)) {
      byKey.set(key, pair)
    }
  }

  return [...byKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([, pair]) => pair)
}

/** A non-terminal workflow already holding one of the pairs. */
export interface BranchHolder {
  readonly workflowId: string
  readonly state: WorkflowState
  readonly repositoryUrl: string
  readonly baseBranch: string
}

/**
 * The refusal, naming the holder (FR-120).
 *
 * `CONFLICT` rather than `FORBIDDEN` or `NOT_FOUND`: the request is well-formed and the caller is
 * entitled to make it. What is wrong is the state of the world right now, and it will stop being
 * wrong when the other run finishes.
 */
export const branchHeldError = (holders: readonly BranchHolder[]): TRPCError =>
  new TRPCError({
    code: 'CONFLICT',
    message: `Another run is already working on ${holders
      .map(
        (holder) =>
          `${holder.baseBranch} in ${holder.repositoryUrl} (run ${holder.workflowId}, ${holder.state})`,
      )
      .join('; ')}. Wait for it to finish, or stop it, before launching this one.`,
  })

/** Anything that can run these statements — the pooled handle or a transaction on it. */
export type BranchLockWriter = Pick<SisyphusDatabase, 'select' | 'execute'>

/** The transaction {@link withBranchLocks} runs its caller's work in. */
export type BranchLockTransaction = Parameters<Parameters<SisyphusDatabase['transaction']>[0]>[0]

/**
 * Take the transaction-scoped lock on every pair, in key order.
 *
 * Blocks until each is available. That is the "serialised" half of FR-120 and it is the half that
 * does the work: a caller that waits and then reads committed state cannot interleave with the
 * caller it waited for.
 *
 * @param writer - The transaction. Session-level use would leak the locks.
 * @param pairs - Already ordered by {@link branchLockPairs}.
 */
export const acquireBranchLocks = async (
  writer: BranchLockWriter,
  pairs: readonly BranchLockPair[],
): Promise<void> => {
  for (const pair of branchLockPairs(pairs)) {
    await writer.execute(sql`select pg_advisory_xact_lock(${branchLockKey(pair)}::bigint)`)
  }
}

/**
 * Which non-terminal workflows hold any of these pairs.
 *
 * The predicate is `state not in (terminal)` rather than `state in (active)`: the two sets
 * partition `WORKFLOW_STATES` today, and if a new lifecycle state is added later this reads it as a
 * holder — which errs toward refusing a launch rather than toward letting two runs onto one branch.
 *
 * @param writer - The transaction the locks were taken in, so this reads committed state.
 * @param pairs - The repository and branch pairs to check.
 * @param options - `excludeWorkflowId` leaves the caller's own run out, for a re-check after its
 *   own entries have been written.
 */
export const findBranchHolders = async (
  writer: BranchLockWriter,
  pairs: readonly BranchLockPair[],
  options: { readonly excludeWorkflowId?: string } = {},
): Promise<readonly BranchHolder[]> => {
  if (pairs.length === 0) {
    return []
  }

  const matchesPair = or(
    ...pairs.map((pair) =>
      and(
        eq(workflowEntries.repositoryUrl, pair.repositoryUrl),
        eq(workflowEntries.baseBranch, pair.baseBranch),
      ),
    ),
  )

  return writer
    .select({
      workflowId: workflows.id,
      state: workflows.state,
      repositoryUrl: workflowEntries.repositoryUrl,
      baseBranch: workflowEntries.baseBranch,
    })
    .from(workflowEntries)
    .innerJoin(workflows, eq(workflows.id, workflowEntries.workflowId))
    .where(
      and(
        matchesPair,
        notInArray(workflows.state, [...TERMINAL_WORKFLOW_STATES]),
        options.excludeWorkflowId === undefined
          ? undefined
          : ne(workflows.id, options.excludeWorkflowId),
      ),
    )
}

export interface BranchLockOptions<TResult> {
  readonly db: SisyphusDatabase
  /** Every entry of the workspace being launched (FR-120: across every entry). */
  readonly pairs: readonly BranchLockPair[]
  /** The run being launched or resumed, left out of the holder search. */
  readonly excludeWorkflowId?: string
  /** The work to do while the branches are held. Runs in the same transaction as the locks. */
  readonly run: (tx: BranchLockTransaction) => Promise<TResult>
}

/**
 * Hold every branch the workspace names, refuse if another run already does, then run the work.
 *
 * The order is the whole design: **lock, then read, then write**. Reading first would be a
 * check-then-write with a longer gap; writing first would put the run on the branch before anyone
 * asked whether it could have it.
 *
 * @param options - The database, the pairs, and what to do under the locks.
 * @returns Whatever `run` returned.
 * @throws {@link branchHeldError} when a non-terminal run already holds one of the pairs.
 */
export const withBranchLocks = async <TResult>(
  options: BranchLockOptions<TResult>,
): Promise<TResult> =>
  options.db.transaction(async (tx) => {
    await acquireBranchLocks(tx, options.pairs)

    const holders = await findBranchHolders(tx, options.pairs, {
      ...(options.excludeWorkflowId === undefined
        ? {}
        : { excludeWorkflowId: options.excludeWorkflowId }),
    })

    if (holders.length > 0) {
      throw branchHeldError(holders)
    }

    return options.run(tx)
  })
