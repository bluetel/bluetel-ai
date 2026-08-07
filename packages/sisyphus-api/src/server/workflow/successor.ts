import { TRPCError } from '@trpc/server'
import type { SQL } from 'drizzle-orm'
import { asc, eq } from 'drizzle-orm'

import type { SisyphusDatabase, Workflow, WorkflowEntry } from '../../db'
import { sessionSnapshots, uuidV7, workflowEntries, workflowEvents, workflows } from '../../db'
import type { ContinueWithChangesInput } from '../../schemas'
import { continueWithChangesInput, workflowIdInput } from '../../schemas'
import { scopedProcedure } from '../procedures'
import type { ResolvedScope } from '../scope'
import { requireWorkflowInScope, scopedWorkflowWhere, workflowNotFoundError } from '../scope'

import type { BranchLockPair } from './branch-lock'
import { withBranchLocks } from './branch-lock'

/**
 * **Successor workflows (T101, T102, FR-149, FR-150, FR-151, FR-152).**
 *
 * A run that stopped at its spend cap is not finished, it is *interrupted by a number*. Raising the
 * cap and carrying on is the obvious thing to want, and the obvious way to give it — edit the cap
 * and restart — is the one thing FR-149 forbids: a workflow's job specification is immutable for
 * its lifetime, so a completed run stays reproducible from its own record. Edit the spec and every
 * report about the earlier run becomes a report about a configuration that no longer exists.
 *
 * So `continueWithChanges` creates a **successor**: a new workflow with its own job spec, linked to
 * its predecessor, inheriting the predecessor's snapshot and workspace. The predecessor is not
 * written to at all — `successor.test.ts` reads its row before and after and compares the whole
 * thing, because "we did not touch it" is exactly the sort of claim that quietly stops being true.
 *
 * ## The session-id relationship, stated once
 *
 * There are **two** session ids in play and they are not the same id:
 *
 * - `workflows.session_id` — the successor's **own**, minted here before it starts (FR-052). This
 *   is what addresses the new run: its credential, its future snapshots, its logs.
 * - the inherited snapshot's `sessionId` — the **predecessor's**, embedded in the conversation
 *   state inside the archive. This is what `--resume` must name, because it is the name the
 *   `.jsonl` on disk is filed under once the archive is unpacked.
 *
 * Conflating them makes `--resume` fail **by finding nothing** rather than by erroring, which is
 * the worst kind of failure to debug: the agent starts, has no history, and produces a confident
 * answer to a question nobody asked it. So the successor's result reports both, separately, under
 * names that cannot be mistaken for each other.
 *
 * ## Continuing *without* a change is a different operation
 *
 * FR-151: continuing with no configuration change resumes the same workflow rather than creating a
 * successor. A request that changes nothing is therefore refused here and pointed at `resume` —
 * silently creating a successor identical to its predecessor would fork the chain for no reason
 * and double every consumption figure summed across it.
 *
 * That distinction is also what decides FR-120 here. A successor takes the predecessor's branches,
 * so `continueWithChanges` runs under `withBranchLocks` exactly as `start` does — and it does
 * **not** exclude the predecessor from the holder search. The full argument is at the call site;
 * the short form is that `resume` is the operation entitled to hold a branch it already holds, and
 * a successor is a second run rather than the same one.
 */

/** Anything that can run these statements — the pooled handle or a transaction on it. */
export type SuccessorWriter = Pick<SisyphusDatabase, 'select' | 'insert'>

/**
 * The first row, honestly typed. `noUncheckedIndexedAccess` is off in this project, so `rows[0]`
 * is typed as present even when the result set is empty.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** The job-spec fields a successor may differ from its predecessor in (FR-150). */
export const CONTINUABLE_FIELDS = ['model', 'turnCap', 'spendCap'] as const

export type ContinuableField = (typeof CONTINUABLE_FIELDS)[number]

/** Refusal for a continuation that changes nothing — that is a resume, not a successor (FR-151). */
export const noChangeRequestedError = (): TRPCError =>
  new TRPCError({
    code: 'BAD_REQUEST',
    message:
      'Continuing without a configuration change resumes the same workflow. Use resume, which ' +
      'keeps one run and one consumption figure, rather than creating a successor identical to it.',
  })

/** Refusal for a predecessor with nothing to inherit. */
export const noInheritableSnapshotError = (reason: string): TRPCError =>
  new TRPCError({ code: 'CONFLICT', message: reason })

/** Refusal for a snapshot that has aged out, stating the limit (FR-016). */
export const snapshotExpiredError = (expiresAt: Date): TRPCError =>
  new TRPCError({
    code: 'CONFLICT',
    message: `That session was retained until ${expiresAt.toISOString()} and can no longer be continued.`,
  })

/**
 * Which fields the request actually changes.
 *
 * Pure, and compared against the predecessor's recorded values rather than merely checking that a
 * field was supplied: re-sending the cap that is already in force is a no-op the user did not mean
 * as a fork, and `spendCap` arrives as a numeric string, so `'25.0000'` and `'25.00'` have to
 * compare equal or every continuation would look like a change.
 */
export const changedFields = (
  predecessor: Pick<Workflow, 'model' | 'turnCap' | 'spendCap'>,
  input: Pick<ContinueWithChangesInput, 'model' | 'turnCap' | 'spendCap'>,
): readonly ContinuableField[] => {
  const changed: ContinuableField[] = []

  if (input.model !== undefined && input.model !== predecessor.model) {
    changed.push('model')
  }

  if (input.turnCap !== undefined && input.turnCap !== predecessor.turnCap) {
    changed.push('turnCap')
  }

  if (
    input.spendCap !== undefined &&
    (predecessor.spendCap === null || Number(input.spendCap) !== Number(predecessor.spendCap))
  ) {
    changed.push('spendCap')
  }

  return changed
}

/** The snapshot a successor inherits. */
export interface InheritedSnapshot {
  readonly snapshotId: string
  /** The **predecessor's** recorded session id — what `--resume` names. */
  readonly resumeSessionId: string
  readonly s3Key: string
}

/**
 * Resolve the predecessor's current snapshot, refusing everything that cannot be resumed.
 *
 * Read through `workflows.current_snapshot_id` rather than by taking the newest row, because that
 * pointer is what `registerSnapshot` advances **only** for a snapshot carrying both state flags
 * (T099). Taking the newest row instead would happily inherit an incomplete capture that the
 * machine surface had deliberately declined to make current.
 */
export const resolveInheritedSnapshot = async (options: {
  readonly writer: SuccessorWriter
  readonly predecessor: Workflow
  readonly now: Date
}): Promise<InheritedSnapshot> => {
  const { writer, predecessor, now } = options

  if (predecessor.currentSnapshotId === null) {
    throw noInheritableSnapshotError(
      'That run has no resumable snapshot, so there is nothing for a successor to continue from.',
    )
  }

  const snapshot = firstRow(
    await writer
      .select({
        id: sessionSnapshots.id,
        sessionId: sessionSnapshots.sessionId,
        s3Key: sessionSnapshots.s3Key,
        expiresAt: sessionSnapshots.expiresAt,
        hasConversationState: sessionSnapshots.hasConversationState,
        hasWorktreeState: sessionSnapshots.hasWorktreeState,
      })
      .from(sessionSnapshots)
      .where(eq(sessionSnapshots.id, predecessor.currentSnapshotId))
      .limit(1),
  )

  if (snapshot === undefined) {
    throw noInheritableSnapshotError(
      'That run’s snapshot is no longer recorded, so there is nothing for a successor to continue from.',
    )
  }

  if (snapshot.expiresAt.getTime() <= now.getTime()) {
    throw snapshotExpiredError(snapshot.expiresAt)
  }

  if (!snapshot.hasConversationState || !snapshot.hasWorktreeState) {
    throw noInheritableSnapshotError(
      'That run’s snapshot is incomplete and cannot be continued from.',
    )
  }

  return { snapshotId: snapshot.id, resumeSessionId: snapshot.sessionId, s3Key: snapshot.s3Key }
}

/** What `continueWithChanges` answers with. */
export interface SuccessorWorkflow {
  readonly workflow: Workflow
  readonly entries: readonly WorkflowEntry[]
  readonly predecessorWorkflowId: string
  /**
   * The successor's **own** id (FR-052) — what addresses the new run.
   *
   * Reported beside {@link SuccessorWorkflow.resumeSessionId} rather than instead of it. See the
   * module comment: one field carrying "the session id" is how the two get conflated.
   */
  readonly sessionId: string
  /** The **predecessor's** recorded id — what `--resume` must name. */
  readonly resumeSessionId: string
  readonly inheritedSnapshotId: string
  readonly changedFields: readonly ContinuableField[]
}

export interface ContinueWithChangesOptions {
  readonly db: SisyphusDatabase
  readonly scope: ResolvedScope
  /** The signed-in human. Owner and initiator of the successor, as a manual launch is. */
  readonly actorUserId: string
  readonly input: ContinueWithChangesInput
}

/**
 * The `(repository_url, base_branch)` pairs a successor would inherit (FR-120).
 *
 * Taken from the **predecessor's** `workflow_entries` rather than from its workspace version,
 * because that is what {@link copyEntries} copies: a successor holds the branches the run it
 * continues held, as they were recorded at that run's launch, not as the workspace names them now.
 *
 * Read outside the transaction, for the same reason as `start.ts`'s equivalent: the locks have to
 * be named before they can be taken. `copyEntries` re-reads the same rows under the locks and is
 * the authoritative read.
 *
 * @param writer - The pooled handle, deliberately not a transaction.
 * @param workflowId - The predecessor.
 */
export const readWorkflowBranchPairs = async (
  writer: SuccessorWriter,
  workflowId: string,
): Promise<readonly BranchLockPair[]> =>
  writer
    .select({
      repositoryUrl: workflowEntries.repositoryUrl,
      baseBranch: workflowEntries.baseBranch,
    })
    .from(workflowEntries)
    .where(eq(workflowEntries.workflowId, workflowId))

/** Copy the predecessor's entry set onto the successor — the same workspace, pinned (FR-150). */
const copyEntries = async (
  writer: SuccessorWriter,
  options: { readonly predecessorWorkflowId: string; readonly successorWorkflowId: string },
): Promise<readonly WorkflowEntry[]> => {
  const source = await writer
    .select()
    .from(workflowEntries)
    .where(eq(workflowEntries.workflowId, options.predecessorWorkflowId))
    .orderBy(asc(workflowEntries.createdAt))

  if (source.length === 0) {
    throw noInheritableSnapshotError(
      'That run has no recorded repositories, so a successor would have nothing to check out.',
    )
  }

  return writer
    .insert(workflowEntries)
    .values(
      source.map((entry) => ({
        workflowId: options.successorWorkflowId,
        workspaceEntryId: entry.workspaceEntryId,
        repositoryUrl: entry.repositoryUrl,
        baseBranch: entry.baseBranch,
        subdirectory: entry.subdirectory,
        isPrimary: entry.isPrimary,
        // Deliberately **not** copied: `resolvedCommit`, `pullRequestUrl`, `entryResult`. Those are
        // facts about what the predecessor did, and a successor starting life already claiming a
        // pull request would make FR-115's "at most one per entry" a lie about two runs.
      })),
    )
    .returning()
}

/**
 * Continue a run with changed configuration, as a successor (FR-150).
 *
 * @param options - See {@link ContinueWithChangesOptions}.
 * @returns The successor, its entries, and both session ids.
 */
export const continueWithChanges = async (
  options: ContinueWithChangesOptions,
): Promise<SuccessorWorkflow> => {
  const { db, scope, actorUserId, input } = options

  // Scope first, and out of scope leaves here as the ordinary `NOT_FOUND` (FR-190). Nothing below
  // runs in that case, so no constraint violation can leak what the check withheld.
  const predecessor = await requireWorkflowInScope({ db, scope, workflowId: input.workflowId })
  const changed = changedFields(predecessor, input)

  if (changed.length === 0) {
    throw noChangeRequestedError()
  }

  const now = new Date()

  // Named before the transaction opens, because they are what the locks are taken on.
  const pairs = await readWorkflowBranchPairs(db, predecessor.id)

  /*
   * FR-120 on the successor path, and the one judgement call in it: **`excludeWorkflowId` is not
   * passed, so a predecessor that is still non-terminal refuses its own successor.**
   *
   * `excludeWorkflowId` exists for *identity* — see `./branch-lock.ts`, where it is described as
   * leaving "the caller's own run" out so a re-check after that run's entries are written does not
   * conflict with itself. A successor is not that run. It is a different `workflows` row, with its
   * own id, its own entries, its own compute lease and its own agent; FR-151 already names the
   * operation that continues the *same* run, and it is `resume`. Excluding the predecessor here
   * would exempt from FR-120 precisely the pair the rule describes: two non-terminal workflows,
   * two instances, one branch, at the same moment.
   *
   * It costs nothing in the case successors exist for. A run continued because a cap interrupted
   * it is `capped`, `parked_resumable` or `failed` — all terminal, none a holder — so the ordinary
   * continuation is unaffected. What is refused is continuing a run that is still `queued`,
   * `provisioning`, `running` or `paused`: those still hold their lease and their worktree, and a
   * paused one can resume under the successor's feet. The refusal names the holder and says to
   * stop it first, which is the actionable half of FR-120.
   */
  return withBranchLocks({
    db,
    pairs,
    run: async (tx) => {
      const inherited = await resolveInheritedSnapshot({ writer: tx, predecessor, now })

      const inserted = firstRow(
        await tx
          .insert(workflows)
          .values({
            // The whole job spec is carried across; only the continued fields differ, and only the
            // three FR-150 admits. Copying rather than re-deriving from the profile matters: the
            // profile may have been edited since, and a successor continues *this* run.
            type: predecessor.type,
            state: 'queued',
            ownerUserId: predecessor.ownerUserId,
            initiatedByUserId: actorUserId,
            originatingIntegrationId: predecessor.originatingIntegrationId,
            originatingMappingId: predecessor.originatingMappingId,
            executionProfileId: predecessor.executionProfileId,
            executionProfileVersionId: predecessor.executionProfileVersionId,
            setupBundleVersionId: predecessor.setupBundleVersionId,
            workspaceVersionId: predecessor.workspaceVersionId,
            ticketReference: predecessor.ticketReference,
            assembledPrompt: predecessor.assembledPrompt,
            promptTruncated: predecessor.promptTruncated,
            model: input.model ?? predecessor.model,
            instanceType: predecessor.instanceType,
            purchaseMode: predecessor.purchaseMode,
            turnCap: input.turnCap ?? predecessor.turnCap,
            spendCap: input.spendCap ?? predecessor.spendCap,
            // Its own, minted before it starts (FR-052). **Not** the predecessor's, and not the
            // snapshot's: see the module comment.
            sessionId: uuidV7(),
            predecessorWorkflowId: predecessor.id,
            // Inherited. The row still belongs to the predecessor — this is a pointer to the
            // snapshot the successor resumes from, which is what "inherits the snapshot" means.
            currentSnapshotId: inherited.snapshotId,
          })
          .returning(),
      )

      if (inserted === undefined) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'The successor workflow could not be created.',
        })
      }

      // The write that puts the successor on those branches, under the locks taken above.
      const entries = await copyEntries(tx, {
        predecessorWorkflowId: predecessor.id,
        successorWorkflowId: inserted.id,
      })

      await tx.insert(workflowEvents).values({
        // On the **successor's** timeline. Nothing is written to the predecessor's — not its row
        // and not its timeline — because FR-149 makes it immutable and an appended event is a
        // write.
        workflowId: inserted.id,
        event: 'created',
        actorType: 'user',
        actorUserId,
        detail: {
          state: 'queued',
          predecessorWorkflowId: predecessor.id,
          inheritedSnapshotId: inherited.snapshotId,
          // Both ids, named apart, so the timeline itself records which one `--resume` gets.
          sessionId: inserted.sessionId,
          resumeSessionId: inherited.resumeSessionId,
          changedFields: changed,
          entryCount: entries.length,
        },
      })

      return {
        workflow: inserted,
        entries,
        predecessorWorkflowId: predecessor.id,
        sessionId: inserted.sessionId,
        resumeSessionId: inherited.resumeSessionId,
        inheritedSnapshotId: inherited.snapshotId,
        changedFields: changed,
      }
    },
  })
}

/** One run in a successor chain, as the panel renders it. */
export interface ChainLink {
  readonly workflowId: string
  readonly predecessorWorkflowId: string | null
  readonly type: Workflow['type']
  readonly state: Workflow['state']
  readonly terminalOutcome: Workflow['terminalOutcome']
  readonly outcomeReason: string | null
  readonly model: Workflow['model']
  readonly turnCap: number | null
  readonly spendCap: string | null
  readonly turnsUsed: number
  readonly spendUsed: string
  readonly sessionId: string
  readonly createdAt: Date
  /** True for the run the chain was requested from. */
  readonly isRequested: boolean
}

/** A chain, oldest first, with the consumption FR-152 asks to be summable across it. */
export interface SuccessorChain {
  readonly requestedWorkflowId: string
  /** Oldest first, so position in the array is position in the chain. */
  readonly links: readonly ChainLink[]
  readonly workflowCount: number
  readonly turnsTotal: number
  readonly spendTotal: string
}

const CHAIN_LINK_COLUMNS = {
  workflowId: workflows.id,
  predecessorWorkflowId: workflows.predecessorWorkflowId,
  type: workflows.type,
  state: workflows.state,
  terminalOutcome: workflows.terminalOutcome,
  outcomeReason: workflows.outcomeReason,
  model: workflows.model,
  turnCap: workflows.turnCap,
  spendCap: workflows.spendCap,
  turnsUsed: workflows.turnsUsed,
  spendUsed: workflows.spendUsed,
  sessionId: workflows.sessionId,
  createdAt: workflows.createdAt,
}

/** How far a chain is followed in either direction before the walk is treated as a fault. */
const MAX_CHAIN_LENGTH = 64

/** One row of {@link CHAIN_LINK_COLUMNS}, before the requested-run marker is added. */
type ChainRow = Omit<ChainLink, 'isRequested'>

/**
 * Read a successor chain in **both** directions (FR-152).
 *
 * Backwards is `predecessor_workflow_id` followed to the root; forwards is the reverse lookup on
 * the same column. The forward direction is the half that cannot be done from a workflow read
 * alone, and it is the half FR-152 is actually about: from any run in a chain you can reach both
 * the run it continues and the run that continues it.
 *
 * ## Every hop is scoped, and the totals are therefore scoped too
 *
 * Each step composes `scopedWorkflowWhere`, so a chain member the caller may not see is simply
 * absent — not named, not counted, not summed (FR-190). That does mean a partially-visible chain
 * reports a partial total, and that is the correct trade: a total that included an invisible run
 * would disclose its existence just as effectively as returning the row would, and would do so in
 * a number nobody would think to check.
 *
 * A run the caller cannot see also stops the walk in that direction rather than being stepped
 * over, because stepping over it would disclose that something sits between two visible runs.
 *
 * @param options.workflowId - Any run in the chain; the answer is the same from any of them.
 */
export const readSuccessorChain = async (options: {
  readonly db: SisyphusDatabase
  readonly scope: ResolvedScope
  readonly workflowId: string
}): Promise<SuccessorChain> => {
  const { db, scope, workflowId } = options

  /** One scoped hop. `undefined` covers "no such run" and "not yours" identically (FR-190). */
  const readLink = async (condition: SQL): Promise<ChainRow | undefined> =>
    firstRow(
      await db
        .select(CHAIN_LINK_COLUMNS)
        .from(workflows)
        .where(scopedWorkflowWhere(scope, condition))
        .orderBy(asc(workflows.createdAt))
        .limit(1),
    )

  const requested = await readLink(eq(workflows.id, workflowId))

  if (requested === undefined) {
    throw workflowNotFoundError()
  }

  const seen = new Set<string>([requested.workflowId])
  const ancestors: ChainRow[] = []
  let cursor = requested.predecessorWorkflowId

  while (cursor !== null && ancestors.length < MAX_CHAIN_LENGTH && !seen.has(cursor)) {
    const previous = await readLink(eq(workflows.id, cursor))

    if (previous === undefined) {
      break
    }

    seen.add(previous.workflowId)
    ancestors.unshift(previous)
    cursor = previous.predecessorWorkflowId
  }

  const descendants: ChainRow[] = []
  let frontier = requested.workflowId

  for (let step = 0; step < MAX_CHAIN_LENGTH; step += 1) {
    const next = await readLink(eq(workflows.predecessorWorkflowId, frontier))

    if (next === undefined || seen.has(next.workflowId)) {
      break
    }

    seen.add(next.workflowId)
    descendants.push(next)
    frontier = next.workflowId
  }

  const ordered = [...ancestors, requested, ...descendants]
  const links = ordered.map(
    (row): ChainLink => ({ ...row, isRequested: row.workflowId === requested.workflowId }),
  )

  return {
    requestedWorkflowId: requested.workflowId,
    links,
    workflowCount: links.length,
    turnsTotal: links.reduce((total, link) => total + link.turnsUsed, 0),
    spendTotal: links.reduce((total, link) => total + Number(link.spendUsed), 0).toFixed(4),
  }
}

/** `workflow.continueWithChanges` — ready to mount (FR-149, FR-150, FR-151). */
export const continueWithChangesProcedure = scopedProcedure
  .input(continueWithChangesInput)
  .mutation(
    async ({ ctx, input }): Promise<SuccessorWorkflow> =>
      continueWithChanges({ db: ctx.db, scope: ctx.scope, actorUserId: ctx.user.id, input }),
  )

/** `workflow.chain` — ready to mount. Traversable in both directions (FR-152, FR-190). */
export const chainProcedure = scopedProcedure
  .input(workflowIdInput)
  .query(
    async ({ ctx, input }): Promise<SuccessorChain> =>
      readSuccessorChain({ db: ctx.db, scope: ctx.scope, workflowId: input.workflowId }),
  )
