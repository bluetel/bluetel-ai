import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'

import type { SisyphusDatabase, Workflow, WorkflowEntry } from '../../db'
import { users, uuidV7, workflowEvents, workflows } from '../../db'
import type { StartAdHocInput } from '../../schemas'

import { requireSelectableBundleVersion } from './ad-hoc-bundle'
import { resolveAdHocJobSpec, willSaveAsProfile } from './ad-hoc-plan'
import { copyWorkspaceEntries, resolveAdHocWorkspace } from './ad-hoc-workspace'
import type { SavedProfile } from './save-as-profile'
import { saveConfigurationAsProfile } from './save-as-profile'
import { readQueuePosition } from './start'

/**
 * `workflow.startAdHoc` — **it writes a `queued` row and returns** (FR-129, FR-187).
 *
 * ## The same absence `./start.ts` has, for the same reason
 *
 * No provisioning, no compute lease, no credential, no outbound call. There is no HTTP client in
 * this file, no queue publish and no SDK. FR-035 requires the control plane to expose no inbound
 * network surface, and the way that requirement survives contact with a panel is for the panel to
 * hold no means of asking for compute at all: the edge between the two components is a row the
 * control plane polls for. A second launch path is exactly where that would erode — one procedure
 * that pokes a job would make the no-ingress rule a convention again — so this one ends at the
 * same `insert` the profile path does.
 *
 * If a future edit here wants to trigger a job, the edit is in the wrong file.
 *
 * ## Why this is admin-only, and why that is the requirement rather than a precaution
 *
 * An ad hoc launch supplies the workspace, model, instance size, caps and setup bundle directly,
 * which is to say it *is* an execution profile — an unnamed one, created and consumed in a single
 * request, that nobody granted to anybody. FR-180 restricts a non-admin to launching on profiles
 * granted to them; a non-admin able to reach this procedure would satisfy that rule vacuously by
 * never naming a profile. The whole per-profile access model routes around it. So the gate is
 * `adminProcedure` (FR-187), and the refusal is recorded by the procedure itself — see
 * `../procedures.ts`, which writes a `not_admin` denial before throwing.
 *
 * ## What it writes
 *
 * One `workflows` row in `queued` with **no execution profile**, one `workflow_entries` row per
 * entry of the resolved workspace version, and one `created` timeline event — plus, when asked, a
 * disabled execution profile carrying the entered configuration, and, when the repository was
 * typed in rather than chosen, a private workspace to hold it. All in one transaction, so a
 * refused launch leaves nothing behind and a started run always has the record of who launched it.
 *
 * There are no `profile_overrides` rows, and there is nothing to put in them: an override is a
 * deviation *from a profile*, and this run had none to deviate from.
 */

/** Everything `startAdHocWorkflow` needs, and nothing it could use to reach outside the database. */
export interface StartAdHocOptions {
  readonly db: SisyphusDatabase
  /** The signed-in admin. Initiator always, and owner unless the form named someone else. */
  readonly actorUserId: string
  readonly input: StartAdHocInput
}

/** What `workflow.startAdHoc` answers with. */
export interface StartedAdHocWorkflow {
  readonly workflow: Workflow
  readonly entries: readonly WorkflowEntry[]
  /** How many queued runs are ahead of this one, this one included — so `1` means next (FR-040). */
  readonly queuePosition: number
  /** The profile the admin asked to keep the configuration as, or `undefined` (FR-129). */
  readonly savedProfile: SavedProfile | undefined
  /** True when a private workspace was created for a hand-entered repository. */
  readonly materialisedWorkspace: boolean
}

/**
 * The first row, honestly typed. `noUncheckedIndexedAccess` is off in this project, so `rows[0]`
 * is typed as present even when the result set is empty.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** The nominated owner is not somebody a run can be handed to. */
export const ownerNotAvailableError = (): TRPCError =>
  new TRPCError({
    code: 'BAD_REQUEST',
    message: 'That user cannot own a run. Choose an active user.',
  })

/**
 * Decide who is accountable for the run (FR-132, FR-176).
 *
 * Defaults to the admin doing the launching, which is what `./start.ts` does for a manual launch
 * and what keeps the run visible to them under FR-189. When the form names somebody else the
 * account must be **active**: `owner_user_id` is not null precisely so every run has a human who
 * can be asked about it, and handing one to a deactivated account creates a run that is nobody's
 * on the day it is created — the state FR-176's `needs_reassignment` exists to recover from, not
 * to be launched into.
 */
export const resolveOwner = async (
  reader: Pick<SisyphusDatabase, 'select'>,
  options: { readonly actorUserId: string; readonly ownerUserId: string | undefined },
): Promise<string> => {
  const { actorUserId, ownerUserId } = options

  if (ownerUserId === undefined || ownerUserId === actorUserId) {
    return actorUserId
  }

  const owner = firstRow(
    await reader
      .select({ id: users.id, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, ownerUserId))
      .limit(1),
  )

  if (!owner?.isActive) {
    throw ownerNotAvailableError()
  }

  return owner.id
}

/**
 * Launch a run with no execution profile (FR-016, FR-129, FR-187).
 *
 * One transaction, one `queued` row, no outbound call.
 *
 * @param options - See {@link StartAdHocOptions}.
 */
export const startAdHocWorkflow = async (
  options: StartAdHocOptions,
): Promise<StartedAdHocWorkflow> => {
  const { db, actorUserId, input } = options

  // Refused before anything is written, and refused without a database round trip: an autonomous
  // run missing a cap is a property of the submitted values alone (FR-055).
  const spec = resolveAdHocJobSpec(input)

  return db.transaction(async (tx) => {
    const ownerUserId = await resolveOwner(tx, { actorUserId, ownerUserId: input.ownerUserId })
    const setupBundleVersionId = await requireSelectableBundleVersion(
      tx,
      input.setupBundleVersionId,
    )
    const workspace = await resolveAdHocWorkspace(tx, {
      workspace: input.workspace,
      actorUserId,
    })

    // Before the run, so a taken name costs a retype rather than leaving the admin with a started
    // run and a save they can no longer repeat.
    const savedProfile = willSaveAsProfile(input.saveAsProfile)
      ? await saveConfigurationAsProfile(tx, {
          saveAs: input.saveAsProfile,
          spec,
          workspaceVersionId: workspace.workspaceVersionId,
          setupBundleVersionId,
          actorUserId,
        })
      : undefined

    const inserted = await tx
      .insert(workflows)
      .values({
        type: spec.workflowType,
        state: 'queued',
        ownerUserId,
        initiatedByUserId: actorUserId,
        // Null on both, and it stays null even when a profile was saved above. FR-126 asks a
        // workflow to record that it was launched ad hoc, and pointing this run at the profile it
        // happened to create would say it was launched *from* one — which is not what happened,
        // and would make the run's configuration look reconstructible from a version that is free
        // to be edited afterwards (FR-125). The link is in the timeline event instead.
        executionProfileId: null,
        executionProfileVersionId: null,
        setupBundleVersionId,
        workspaceVersionId: workspace.workspaceVersionId,
        ticketReference: input.ticketReference ?? null,
        // As sent. There is no profile preamble to sit above it — the prompt is the whole of it,
        // and a run whose prompt has to be reconstructed later is a run nobody can audit (FR-065).
        assembledPrompt: input.prompt,
        model: spec.model,
        instanceType: spec.instanceType,
        purchaseMode: spec.purchaseMode,
        turnCap: spec.turnCap,
        spendCap: spec.spendCap,
        // Assigned by the platform **before** the agent starts, so the run is addressable even if
        // it fails before producing output (FR-052). Never parsed out of agent output.
        sessionId: uuidV7(),
      })
      .returning()

    const workflow = firstRow(inserted)
    if (workflow === undefined) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'The workflow could not be created.',
      })
    }

    const entries = await copyWorkspaceEntries(tx, {
      workflowId: workflow.id,
      workspaceVersionId: workspace.workspaceVersionId,
    })

    await tx.insert(workflowEvents).values({
      workflowId: workflow.id,
      event: 'created',
      actorType: 'user',
      actorUserId,
      // One event, not `created` followed by `queued`: the row is queued from the instant it
      // exists. `admitted` is the next entry, and the control plane writes it.
      detail: {
        state: 'queued',
        adHoc: true,
        entryCount: entries.length,
        materialisedWorkspace: workspace.materialised,
        workspaceVersionId: workspace.workspaceVersionId,
        setupBundleVersionId,
        // The only record that this launch also produced a profile. Deliberately here rather than
        // on the row: it is something that happened, not something the run ran on.
        savedAsExecutionProfileId: savedProfile?.executionProfileId ?? null,
      },
    })

    return {
      workflow,
      entries,
      queuePosition: await readQueuePosition(tx, workflow.id),
      savedProfile,
      materialisedWorkspace: workspace.materialised,
    }
  })
}
