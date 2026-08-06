/* cspell:ignore launchable */
import { TRPCError } from '@trpc/server'
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm'

import type { ExecutionProfileVersion, SisyphusDatabase, Workflow, WorkflowEntry } from '../../db'
import {
  executionProfiles,
  executionProfileVersions,
  profileOverrides,
  sessionSnapshots,
  uuidV7,
  workflowEntries,
  workflowEvents,
  workflows,
  workspaceEntries,
} from '../../db'
import type { StartWorkflowInput } from '../../schemas'
import type { ResolvedScope } from '../scope'
import { scopedWorkflowWhere, workflowNotFoundError } from '../scope'

import type { BranchLockPair } from './branch-lock'
import { withBranchLocks } from './branch-lock'
import type { LaunchPlan } from './launch-plan'
import { resolveLaunchPlan } from './launch-plan'

/**
 * `workflow.start` — **it writes a `queued` row and returns.**
 *
 * ## What this module deliberately does not do
 *
 * It does not provision, does not take a compute lease, does not mint a credential, and does not
 * call anything. There is no HTTP client in this file, no queue publish, no SDK. That absence is
 * the feature: FR-035 requires the control plane to expose **no inbound network surface**, and the
 * way that requirement survives contact with a panel is for the panel to hold no means of asking
 * for compute at all. The edge between the two components is this row — the control plane polls
 * for `queued` workflows and admits them under the FR-040 ceiling, taking the `compute_leases`
 * partial unique index as it goes (FR-078).
 *
 * So "the panel cannot reach the control plane" is not a firewall rule anybody has to remember to
 * keep in place, and not a route nobody has got round to adding. It is that the only thing on the
 * panel's side of the line is an `insert`.
 *
 * If a future edit here wants to trigger a job, the edit is in the wrong file.
 *
 * ## What it does write
 *
 * One `workflows` row in `queued`, one `workflow_entries` row per entry of the pinned workspace
 * version, one `profile_overrides` row per accepted deviation (FR-123), and one `created`
 * timeline event (FR-064) — all in a single transaction, so a run can never exist without the
 * record of who launched it and what they changed.
 *
 * ## The transaction is `withBranchLocks`, not `db.transaction` (FR-120)
 *
 * Writing `workflow_entries` is what puts a run on a branch, so this is the path where two runs
 * can end up holding the same `(repository_url, base_branch)` pair — and the guard belongs where
 * the write is rather than in a caller that has to remember to ask. `./branch-lock.ts` holds the
 * advisory locks for the whole transaction: they are taken, the holders are read *under* them, and
 * the insert happens before they are released at commit. There is no window between the check and
 * the write for a second launcher to fit into, which is the entire difference between this and a
 * `select` followed by an `insert`.
 */

/** Everything `startWorkflow` needs, and nothing it could use to reach outside the database. */
export interface StartWorkflowOptions {
  readonly db: SisyphusDatabase
  /** The caller's resolved visible set. Used for the FR-180 grant check and nothing else. */
  readonly scope: ResolvedScope
  /** The signed-in human. Owner **and** initiator of a manually launched run (FR-132, FR-189). */
  readonly actorUserId: string
  readonly input: StartWorkflowInput
}

/** What `workflow.start` answers with. */
export interface StartedWorkflow {
  readonly workflow: Workflow
  readonly entries: readonly WorkflowEntry[]
  /**
   * How many queued runs are ahead of this one, this one included — so `1` means next.
   *
   * Lets the caller tell "waiting" from "stuck", which FR-040's queueing behaviour is otherwise
   * indistinguishable from. See {@link readQueuePosition} for why this one figure is not scoped.
   */
  readonly queuePosition: number
}

/**
 * The single refusal for a profile this caller cannot launch on.
 *
 * Deliberately singular across three situations — the profile does not exist, the caller holds no
 * live grant on it, and it has no published version — for the same reason `grantTargetNotFoundError`
 * is: a refusal that distinguished them would answer "does this profile id exist?" for ids the
 * caller has never been shown (FR-180, FR-190). The message names nothing.
 */
export const profileNotAvailableError = (): TRPCError =>
  new TRPCError({ code: 'NOT_FOUND', message: 'No such execution profile.' })

/**
 * Refusal for a profile the caller *can* see but that is not launchable right now.
 *
 * Separate from {@link profileNotAvailableError} and safe to be separate: reaching this requires
 * holding the profile, so naming its state discloses nothing the caller did not already have.
 * `CONFLICT` because the request is well-formed and the caller is entitled to make it — what is
 * wrong is the target's current state.
 */
export const profileNotLaunchableError = (reason: string): TRPCError =>
  new TRPCError({ code: 'CONFLICT', message: reason })

/** A session snapshot that cannot be restored because it has aged out (FR-016). */
export const snapshotExpiredError = (expiresAt: Date): TRPCError =>
  new TRPCError({
    code: 'CONFLICT',
    message: `That session was retained until ${expiresAt.toISOString()} and can no longer be restored.`,
  })

/** Anything that can run this module's statements — the pooled handle or a transaction on it. */
export type LaunchWriter = Pick<SisyphusDatabase, 'select' | 'insert'>

/**
 * The first row, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this project, so `rows[0]` is typed as present even when
 * the result set is empty and a `=== undefined` guard is narrowed away as unreachable. Going
 * through a function whose declared return type admits `undefined` restores the check.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * May this caller launch on this profile (FR-180, FR-183)?
 *
 * An admin may, without a grant. Everyone else must hold a live one — and the set is the same
 * `visibleProfileIds` every scoped read composes from, not a second grants query with its own
 * opinion about what "live" means.
 */
export const mayLaunchOnProfile = (scope: ResolvedScope, executionProfileId: string): boolean =>
  scope.isAdmin || scope.visibleProfileIds.includes(executionProfileId)

/**
 * Load the profile version a launch pins, refusing everything that is not launchable.
 *
 * The version is read through `execution_profiles.current_version_id` rather than by taking the
 * highest version number: advancing that pointer is what publishing a version *is* (FR-125), and a
 * `max(version)` would launch against a version an admin has not published yet.
 */
export const loadLaunchableProfileVersion = async (
  writer: LaunchWriter,
  executionProfileId: string,
): Promise<ExecutionProfileVersion> => {
  const rows = await writer
    .select({ profile: executionProfiles, version: executionProfileVersions })
    .from(executionProfiles)
    .leftJoin(
      executionProfileVersions,
      eq(executionProfileVersions.id, executionProfiles.currentVersionId),
    )
    .where(eq(executionProfiles.id, executionProfileId))
    .limit(1)

  const row = firstRow(rows)
  if (row === undefined) {
    throw profileNotAvailableError()
  }

  // A profile with no published version cannot be launched, and saying so separately from "no such
  // profile" would tell a caller that an id they have never been shown is real.
  if (row.version === null) {
    throw profileNotAvailableError()
  }

  if (row.profile.archivedAt !== null) {
    throw profileNotLaunchableError('This execution profile has been archived.')
  }

  if (!row.profile.enabled) {
    throw profileNotLaunchableError('This execution profile is disabled and cannot start runs.')
  }

  return row.version
}

/**
 * Resolve `resumeFromSessionId` to a restorable snapshot (FR-016, US3).
 *
 * Restoring a stored session into a **new** workflow is a different operation from continuing an
 * existing one by id, and the reference is checked in that order for a reason: **scope before
 * expiry**. A snapshot belonging to a run the caller cannot see leaves here as the ordinary
 * `NOT_FOUND`, so "that session expired" is never said about a run whose existence the caller was
 * not entitled to learn (FR-190).
 */
export const resolveResumeSnapshot = async (options: {
  readonly writer: LaunchWriter
  readonly scope: ResolvedScope
  readonly sessionId: string
  readonly now: Date
}): Promise<{ readonly snapshotId: string; readonly predecessorWorkflowId: string }> => {
  const { writer, scope, sessionId, now } = options

  const rows = await writer
    .select({
      id: sessionSnapshots.id,
      workflowId: sessionSnapshots.workflowId,
      expiresAt: sessionSnapshots.expiresAt,
      hasConversationState: sessionSnapshots.hasConversationState,
      hasWorktreeState: sessionSnapshots.hasWorktreeState,
    })
    .from(sessionSnapshots)
    // The join is what scopes it: the snapshot inherits the visibility of the run it was taken
    // from, and the predicate is the one base selector rather than a rule invented here.
    .innerJoin(workflows, eq(workflows.id, sessionSnapshots.workflowId))
    .where(scopedWorkflowWhere(scope, eq(sessionSnapshots.sessionId, sessionId)))
    .orderBy(desc(sessionSnapshots.createdAt))
    .limit(1)

  const snapshot = firstRow(rows)
  if (snapshot === undefined) {
    throw workflowNotFoundError()
  }

  if (snapshot.expiresAt.getTime() <= now.getTime()) {
    throw snapshotExpiredError(snapshot.expiresAt)
  }

  // A snapshot missing either state flag restores an agent whose filesystem beliefs are wrong, or
  // a tree nobody can explain (FR-050). Discovering that at restore time means the run is already
  // lost, so it is discovered here.
  if (!snapshot.hasConversationState || !snapshot.hasWorktreeState) {
    throw profileNotLaunchableError('That session snapshot is incomplete and cannot be restored.')
  }

  return { snapshotId: snapshot.id, predecessorWorkflowId: snapshot.workflowId }
}

/**
 * Assemble the prompt as sent (FR-159, FR-165).
 *
 * Two layers for a manual launch: the profile's preamble, then the engineer's own prompt — which
 * for a manually started run occupies the layer an integration's `prompt_intro` would otherwise
 * fill. Recorded on the row **as sent**, because a run whose prompt has to be reconstructed later
 * from its inputs is a run nobody can audit (FR-065).
 */
export const assemblePrompt = (preamble: string | null, prompt: string): string =>
  preamble === null || preamble.trim() === '' ? prompt : `${preamble}\n\n${prompt}`

/**
 * How many queued runs are ahead of this one.
 *
 * **Deliberately not scoped, and this is the one read in the package that is not.** It is a
 * property of the platform's admission queue rather than a fact about anybody's workflow: it names
 * no run, no owner and no profile, and it is derived from the caller's own row. Scoping it would
 * make it *wrong* rather than safe — "position 1" while forty runs sat ahead is exactly the "stuck
 * or waiting?" confusion FR-040's queue position exists to remove.
 *
 * Nothing else in this package reads `workflows` without the base selector.
 */
export const readQueuePosition = async (
  writer: LaunchWriter,
  workflowId: string,
): Promise<number> => {
  const rows = await writer
    .select({ value: sql<string>`count(*)` })
    .from(workflows)
    .where(and(eq(workflows.state, 'queued'), lte(workflows.id, workflowId)))

  return Number(firstRow(rows)?.value ?? 0)
}

/**
 * The `(repository_url, base_branch)` pairs a workspace version would put a run on (FR-120).
 *
 * Read **outside** the transaction, and that is not an oversight. `withBranchLocks` has to know
 * which advisory keys to take before it opens a transaction to take them in, so something has to
 * name the branches first. What this read is not is the check: it decides only *which* locks to
 * acquire. The authoritative read of the same rows happens under those locks, in
 * {@link insertEntries}, and that is the one the run's entries are written from — so a workspace
 * version whose rows somehow differed between the two would produce a run whose entries and whose
 * locks disagree rather than a run that skipped the guard. Workspace versions are immutable once
 * published (FR-125), which is why the two reads agree in practice.
 *
 * @param writer - The pooled handle, deliberately not a transaction.
 * @param workspaceVersionId - The pinned version the launch plan resolved.
 */
export const readWorkspaceBranchPairs = async (
  writer: LaunchWriter,
  workspaceVersionId: string,
): Promise<readonly BranchLockPair[]> =>
  writer
    .select({
      repositoryUrl: workspaceEntries.repositoryUrl,
      baseBranch: workspaceEntries.baseBranch,
    })
    .from(workspaceEntries)
    .where(eq(workspaceEntries.workspaceVersionId, workspaceVersionId))

/** Copy the pinned workspace version's entries onto the run (FR-114, FR-125). */
const insertEntries = async (
  writer: LaunchWriter,
  options: { readonly workflowId: string; readonly workspaceVersionId: string },
): Promise<readonly WorkflowEntry[]> => {
  const entries = await writer
    .select()
    .from(workspaceEntries)
    .where(eq(workspaceEntries.workspaceVersionId, options.workspaceVersionId))
    .orderBy(asc(workspaceEntries.position))

  if (entries.length === 0) {
    // A workspace version with no entries would produce a run with nothing to check out, and the
    // executor would discover it at phase 6 having already paid for an instance.
    throw profileNotLaunchableError(
      'This execution profile pins a workspace version with no repositories.',
    )
  }

  return writer
    .insert(workflowEntries)
    .values(
      entries.map((entry) => ({
        workflowId: options.workflowId,
        workspaceEntryId: entry.id,
        repositoryUrl: entry.repositoryUrl,
        baseBranch: entry.baseBranch,
        subdirectory: entry.subdirectory,
        isPrimary: entry.isPrimary,
      })),
    )
    .returning()
}

/** Record every accepted deviation from the profile, so the run's configuration is explicable. */
const insertOverrides = async (
  writer: LaunchWriter,
  options: {
    readonly workflowId: string
    readonly actorUserId: string
    readonly plan: LaunchPlan
  },
): Promise<void> => {
  if (options.plan.overrides.length === 0) {
    return
  }

  await writer.insert(profileOverrides).values(
    options.plan.overrides.map((override) => ({
      workflowId: options.workflowId,
      field: override.field,
      profileValue: override.profileValue,
      usedValue: override.usedValue,
      setByUserId: options.actorUserId,
    })),
  )
}

/**
 * Launch a run from an execution profile (FR-016, FR-122, FR-180).
 *
 * One transaction, one `queued` row, no outbound call. The caller is recorded as both owner and
 * initiator: a manually launched run is owned by the person who launched it, which is what keeps
 * it visible to them under FR-189 even if their grant is later revoked (FR-188).
 *
 * @param options - See {@link StartWorkflowOptions}.
 */
export const startWorkflow = async (options: StartWorkflowOptions): Promise<StartedWorkflow> => {
  const { db, scope, actorUserId, input } = options

  if (!mayLaunchOnProfile(scope, input.executionProfileId)) {
    // FR-180 also asks for the attempt to be recorded. The only recorder available to a resolver
    // is `ctx.dependencies.recordDenial`, whose reason vocabulary is closed and has no member for
    // a profile the caller does not hold; the router notes this rather than logging it under a
    // reason that would be a lie. See the module note in `./router.ts`.
    throw profileNotAvailableError()
  }

  const now = new Date()

  // Resolved before the transaction opens, because the branches this launch would take have to be
  // named before they can be locked. Both are reads and neither writes anything, so a refusal here
  // — an unavailable profile, a locked override — leaves the world exactly as it found it.
  const profileVersion = await loadLaunchableProfileVersion(db, input.executionProfileId)
  const plan = resolveLaunchPlan(profileVersion, input.overrides)
  const pairs = await readWorkspaceBranchPairs(db, plan.workspaceVersionId)

  // FR-120, and the reason this is `withBranchLocks` rather than a check followed by an insert:
  // the locks, the holder probe and every write below happen in **one** transaction. Taking the
  // locks in a transaction of their own would release them at its commit — before the insert they
  // exist to protect — which is the check-then-write this guard replaces.
  return withBranchLocks({
    db,
    pairs,
    run: async (tx) => {
      const resume =
        input.resumeFromSessionId === undefined
          ? undefined
          : await resolveResumeSnapshot({
              writer: tx,
              scope,
              sessionId: input.resumeFromSessionId,
              now,
            })

      const inserted = await tx
        .insert(workflows)
        .values({
          type: plan.workflowType,
          state: 'queued',
          ownerUserId: actorUserId,
          initiatedByUserId: actorUserId,
          executionProfileId: input.executionProfileId,
          executionProfileVersionId: plan.executionProfileVersionId,
          setupBundleVersionId: plan.setupBundleVersionId,
          workspaceVersionId: plan.workspaceVersionId,
          ticketReference: input.ticketReference ?? null,
          assembledPrompt: assemblePrompt(profileVersion.promptPreamble, input.prompt),
          model: plan.model,
          instanceType: plan.instanceType,
          purchaseMode: plan.purchaseMode,
          turnCap: plan.turnCap,
          spendCap: plan.spendCap,
          // Assigned by the platform **before** the agent starts, so the run is addressable even
          // if it fails before producing output (FR-052). Never parsed out of agent output.
          sessionId: uuidV7(),
          // A run restored from a stored session continues that run's chain, which is what makes
          // consumption summable across it (FR-152) and what tells the executor whose recorded
          // session id `--resume` must name (contracts/executor-protocol.md → Restore).
          predecessorWorkflowId: resume?.predecessorWorkflowId ?? null,
        })
        .returning()

      const workflow = firstRow(inserted)
      if (workflow === undefined) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'The workflow could not be created.',
        })
      }

      // The authoritative read of the workspace version's entries, and the write that puts this
      // run on those branches — both under the locks taken above.
      const entries = await insertEntries(tx, {
        workflowId: workflow.id,
        workspaceVersionId: plan.workspaceVersionId,
      })

      await insertOverrides(tx, { workflowId: workflow.id, actorUserId, plan })

      await tx.insert(workflowEvents).values({
        workflowId: workflow.id,
        event: 'created',
        actorType: 'user',
        actorUserId,
        // One event, not `created` followed by `queued`: the row is queued from the instant it
        // exists, and two entries a microsecond apart would read as two things having happened.
        // `admitted` is the next entry, and the control plane writes it.
        detail: {
          state: 'queued',
          executionProfileId: input.executionProfileId,
          executionProfileVersionId: plan.executionProfileVersionId,
          entryCount: entries.length,
          overriddenFields: plan.overrides.map((override) => override.field),
          resumedFromSnapshotId: resume?.snapshotId ?? null,
        },
      })

      return {
        workflow,
        entries,
        queuePosition: await readQueuePosition(tx, workflow.id),
      }
    },
  })
}
