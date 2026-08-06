import { TRPCError } from '@trpc/server'
import { and, eq } from 'drizzle-orm'

import type { SessionSnapshot, SisyphusDatabase } from '../../db'
import { sessionSnapshots, workflowEvents, workflows } from '../../db'
import type { RegisterSnapshotInput } from '../../schemas'
import { assertMachineWorkflowMatches } from '../procedures'

import type { MachineContext } from './guard'
import { firstRow } from './guard'

/**
 * **`machine.registerSnapshot` — what makes a run resumable (T099, FR-050, FR-053).**
 *
 * FR-050 requires **both** halves: the agent's conversation state and the workspace state,
 * uncommitted work included. A snapshot carrying one of them is not a smaller snapshot, it is an
 * unusable one — conversation state without the worktree restores an agent whose beliefs about the
 * filesystem are wrong, and the worktree without the conversation restores a tree nobody can
 * explain.
 *
 * ## "Not resumable" is enforced here, not documented
 *
 * The executor derives the two flags from the finished archive's member list rather than asserting
 * them, so a `false` means the tar really did not contain that half. This resolver acts on that:
 *
 * - the row is **always written**, because the fact that a snapshot was attempted, and what came
 *   out of it, is worth keeping;
 * - `is_current` is set **only** when both flags are true, and the partial unique index
 *   `session_snapshots_current_key` means at most one such row per workflow;
 * - `workflows.current_snapshot_id` advances **only** for a resumable snapshot, so a bad capture
 *   can never displace the last good one. That is the property that matters: the failure mode
 *   being avoided is a run that had a recoverable point and lost it to a later, emptier snapshot.
 *
 * `resolveResumeSnapshot` in `workflow/start.ts` refuses an incomplete snapshot too. That is not a
 * duplicated check — it is the same rule enforced at both ends, and the reason this end exists is
 * that discovering it at restore time means the run is already lost.
 *
 * ## The cross-workflow surface here is the session id
 *
 * The payload names no workflow — deliberately, as on every machine procedure — so the row is
 * written against `ctx.workflowId` and nothing else. What it *does* name is a `sessionId`, and a
 * credential for workflow A registering a snapshot under workflow B's session id would file A's
 * archive against B's conversation. So the claimed id is resolved and checked, and the refusal goes
 * through `assertMachineWorkflowMatches` — the same recorder every other cross-workflow refusal
 * uses, so the security event has one shape and one reason (FR-018, SC-014).
 *
 * The accepted set is **not** simply the workflow's own `session_id`. A successor created by
 * `continueWithChanges` (FR-150) resumes under its **predecessor's** recorded id and the agent goes
 * on appending to that conversation, so the successor's snapshots legitimately carry the
 * predecessor's session id. The chain of predecessors is therefore what is accepted — and nothing
 * outside it.
 */

/** The audit path recorded against a cross-workflow snapshot registration. */
export const REGISTER_SNAPSHOT_PATH = 'machine.registerSnapshot'

/**
 * How long a snapshot is retained, in days.
 *
 * Shorter than logs and artifacts, because a snapshot is a whole workspace and its value decays:
 * it exists to resume a run, and a run nobody resumed in a month is not going to be. The bucket's
 * lifecycle policy enforces the object side (FR-071); this column is what lets the panel refuse a
 * successor from an expired snapshot **with the limit stated** rather than with a missing object.
 */
export const SNAPSHOT_RETENTION_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/** When a snapshot taken now ages out. */
export const snapshotExpiry = (takenAt: Date): Date =>
  new Date(takenAt.getTime() + SNAPSHOT_RETENTION_DAYS * DAY_MS)

/** How far back the predecessor chain is followed before the walk is treated as a fault. */
const MAX_CHAIN_DEPTH = 64

/** Which half of FR-050 a snapshot is missing. */
export type MissingSnapshotState = 'conversation' | 'worktree'

/**
 * The halves this snapshot does not have. Empty means resumable.
 *
 * Pure, so "a snapshot missing either flag is not resumable" is a rule under test rather than a
 * sentence in a comment.
 */
export const missingSnapshotState = (input: {
  readonly hasConversationState: boolean
  readonly hasWorktreeState: boolean
}): readonly MissingSnapshotState[] => {
  const missing: MissingSnapshotState[] = []

  if (!input.hasConversationState) {
    missing.push('conversation')
  }

  if (!input.hasWorktreeState) {
    missing.push('worktree')
  }

  return missing
}

/** What the executor gets back. */
export interface RegisteredSnapshot {
  readonly snapshot: SessionSnapshot
  /**
   * True when both flags were set and this snapshot is now the workflow's resume point.
   *
   * Reported rather than implied, so an executor that captured half a workspace learns it at the
   * boundary it captured, while the instance is still alive.
   */
  readonly resumable: boolean
  /** Empty when resumable; otherwise the half or halves that were absent. */
  readonly missing: readonly MissingSnapshotState[]
}

/** Anything that can run this module's statements — the pooled handle or a transaction on it. */
type SnapshotWriter = Pick<SisyphusDatabase, 'select' | 'insert' | 'update'>

/**
 * The session ids the credential's workflow may legitimately register a snapshot under: its own,
 * and every predecessor's.
 *
 * Walked rather than joined because the chain is short and a bounded loop makes the depth limit
 * explicit. A cycle — which the schema does not prevent — terminates on the visited set rather than
 * spinning.
 */
export const chainSessionIds = async (
  writer: SnapshotWriter,
  workflowId: string,
): Promise<readonly string[]> => {
  const sessionIds: string[] = []
  const visited = new Set<string>()
  let current: string | null = workflowId

  for (let depth = 0; current !== null && depth < MAX_CHAIN_DEPTH; depth += 1) {
    if (visited.has(current)) {
      break
    }

    visited.add(current)

    const row: { sessionId: string; predecessorWorkflowId: string | null } | undefined = firstRow(
      await writer
        .select({
          sessionId: workflows.sessionId,
          predecessorWorkflowId: workflows.predecessorWorkflowId,
        })
        .from(workflows)
        .where(eq(workflows.id, current))
        .limit(1),
    )

    if (row === undefined) {
      break
    }

    sessionIds.push(row.sessionId)
    current = row.predecessorWorkflowId
  }

  return sessionIds
}

/**
 * Refuse a session id that is not the credential's workflow's own or an ancestor's.
 *
 * The refusal is recorded before it is thrown. A session id matching **no** workflow is refused
 * identically to one belonging to somebody else, for the same reason `requireEntryInWorkflow` does
 * it: telling the caller "that session does not exist" while telling them "that session is not
 * yours" for a real one would make this procedure an oracle for enumerating session ids.
 *
 * @param ctx - The machine resolver context.
 * @param sessionId - The session id named in the payload.
 */
export const requireSessionInChain = async (
  ctx: MachineContext,
  sessionId: string,
): Promise<void> => {
  const permitted = await chainSessionIds(ctx.db, ctx.workflowId)

  if (permitted.includes(sessionId)) {
    return
  }

  const owning = firstRow(
    await ctx.db
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.sessionId, sessionId))
      .limit(1),
  )?.id

  await assertMachineWorkflowMatches(
    ctx,
    owning ?? `unknown-session:${sessionId}`,
    REGISTER_SNAPSHOT_PATH,
  )

  // `assertMachineWorkflowMatches` returns without throwing only when the ids match, and they
  // cannot: a session id owned by this very workflow would have been in `permitted` already. This
  // is the "somebody widened the chain walk" case, and it must not read as success.
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'This credential does not cover that session.',
  })
}

/**
 * Register a session snapshot against the credential's workflow (FR-050, FR-053).
 *
 * One transaction: the previous current snapshot is stood down, the new row is written, and the
 * workflow's resume pointer moves — but only when the snapshot is resumable, and the three
 * statements have to be atomic or a crash between them leaves a workflow pointing at a snapshot
 * that is no longer marked current.
 *
 * @param ctx - The machine resolver context.
 * @param input - The validated `registerSnapshot` payload.
 */
export const registerSnapshot = async (
  ctx: MachineContext,
  input: RegisterSnapshotInput,
): Promise<RegisteredSnapshot> => {
  await requireSessionInChain(ctx, input.sessionId)

  const missing = missingSnapshotState(input)
  const resumable = missing.length === 0
  const now = new Date()

  return ctx.db.transaction(async (writer) => {
    if (resumable) {
      // Stood down first, because `session_snapshots_current_key` admits one current row per
      // workflow. Only a resumable snapshot displaces the last good one — an incomplete capture
      // leaves the previous resume point exactly where it was.
      await writer
        .update(sessionSnapshots)
        .set({ isCurrent: false })
        .where(
          and(
            eq(sessionSnapshots.workflowId, ctx.workflowId),
            eq(sessionSnapshots.isCurrent, true),
          ),
        )
    }

    const inserted = firstRow(
      await writer
        .insert(sessionSnapshots)
        .values({
          // Never a workflow named in the payload — there is no field for one.
          workflowId: ctx.workflowId,
          sessionId: input.sessionId,
          s3Key: input.s3Key,
          sizeBytes: input.sizeBytes,
          boundary: input.boundary,
          hasConversationState: input.hasConversationState,
          hasWorktreeState: input.hasWorktreeState,
          truncationRepaired: input.truncationRepaired,
          isCurrent: resumable,
          expiresAt: snapshotExpiry(now),
        })
        .returning(),
    )

    if (inserted === undefined) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'The session snapshot could not be recorded.',
      })
    }

    if (resumable) {
      await writer
        .update(workflows)
        .set({ currentSnapshotId: inserted.id })
        .where(eq(workflows.id, ctx.workflowId))
    }

    await writer.insert(workflowEvents).values({
      workflowId: ctx.workflowId,
      event: 'snapshot_registered',
      actorType: 'executor',
      // The timeline records the incomplete case too. A snapshot that did not become the resume
      // point, with no entry saying so, is a gap an operator has no way to notice.
      detail: {
        snapshotId: inserted.id,
        boundary: input.boundary,
        sessionId: input.sessionId,
        sizeBytes: input.sizeBytes,
        resumable,
        missing,
        truncationRepaired: input.truncationRepaired,
      },
    })

    return { snapshot: inserted, resumable, missing }
  })
}
