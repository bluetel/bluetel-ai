import { eq } from 'drizzle-orm'

import type { SisyphusDatabase, Workflow } from '../../db'
import {
  executionProfiles,
  executionProfileVersions,
  workspaces,
  workspaceVersions,
} from '../../db'
import type { ScopedReadOptions } from '../scope'
import { requireWorkflowInScope } from '../scope'

/**
 * **Reading a run back as it was launched (SC-021, FR-065, FR-126).**
 *
 * SC-021 asks that a completed workflow's bootstrap stay reconstructable for the whole retention
 * period. The read path could not do that: every resolver in `./queries.ts` joined
 * `execution_profiles` — the mutable parent row — for its name, and nothing joined
 * `execution_profile_versions` at all, so `findProfileVersion` was only ever reached through
 * `profile.current_version_id`. A run launched under version 3 read back showing version 7's
 * preamble and locked fields the moment somebody edited the profile, with nothing on screen saying
 * so. The pin was recorded correctly and then not read.
 *
 * ## The split this module exists to make structural
 *
 * A configuration read back from a run is two different kinds of value, and mixing them is exactly
 * the bug above:
 *
 * - {@link PinnedLaunchValues} — what the run *ran with*. Every field comes from a row that cannot
 *   change: the workflow row itself, which is write-once for the job spec (see `schema/workflow.ts`
 *   — continuing with different settings creates a successor, never an edit), and the
 *   `execution_profile_versions` row the launch pinned, which is never updated (see the module note
 *   on `admin/profile-store.ts`). These are the answer to "what did this run do?".
 * - {@link LiveDisplayNames} — what the thing is *called now*. Names live on the mutable parent
 *   rows, and the panel wants the current one: a profile renamed from "Payments" to "Payments
 *   (legacy)" should read back under the name an operator recognises today. A name is not a launch
 *   value and cannot change what a run did, which is why it is safe to take from the live row —
 *   and why it is kept in a separate object rather than sitting alongside the pinned fields.
 *
 * They are nested rather than flattened deliberately. A flat shape with a comment is a convention;
 * `configuration.pinned.instanceType` versus `configuration.live.executionProfileName` cannot be
 * got wrong by a caller who has not read the comment.
 *
 * ## Why the pinned values come off the workflow row rather than the profile version
 *
 * Because a run may legitimately disagree with its profile version: FR-123 permits a per-run
 * override of any unlocked field, recorded on the workflow. The workflow row is therefore the
 * launch record, and the pinned profile version supplies only what the workflow does not carry —
 * the version *number*, the preamble that was prepended, and the fields that were locked at the
 * time. Reading the model or the caps off the profile version instead would silently discard every
 * override, which is the same class of mistake as reading the current version.
 */

/** Anything that can run the statements here — the pooled handle or a transaction. */
export type LaunchConfigurationReader = Pick<SisyphusDatabase, 'select'>

/**
 * The first row, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this project, so `rows[0]` is typed as present even when the
 * result set is empty, and a `=== undefined` guard against it is narrowed away as unreachable.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * What the run launched with. **Every field here is read from an immutable row.**
 *
 * An edit to the profile, the workspace or the bundle after launch changes none of it.
 */
export interface PinnedLaunchValues {
  /** Null when the run was launched ad hoc, with no profile at all (FR-126, FR-129). */
  readonly executionProfileId: string | null
  readonly executionProfileVersionId: string | null
  /** The version *number* the run pinned — "version 3 of Payments", not "Payments". */
  readonly executionProfileVersion: number | null
  readonly workspaceVersionId: string
  readonly workspaceVersion: number
  readonly setupBundleVersionId: string
  readonly workflowType: Workflow['type']
  readonly model: Workflow['model']
  readonly instanceType: string
  readonly purchaseMode: Workflow['purchaseMode']
  readonly turnCap: number | null
  readonly spendCap: string | null
  /** The prompt **as sent**, preamble included (FR-065). Null only for a validation run. */
  readonly assembledPrompt: string | null
  /** The preamble carried by the pinned version, not by the profile as it stands (FR-157). */
  readonly promptPreamble: string | null
  /** The fields an override could not touch at launch (FR-123). */
  readonly lockedFields: readonly string[]
}

/**
 * Names taken from the mutable current rows, for display continuity.
 *
 * Never a launch value. Kept apart so a caller cannot reach for one by accident.
 */
export interface LiveDisplayNames {
  /** Null when the run was ad hoc, or when the profile row has since been removed. */
  readonly executionProfileName: string | null
  readonly workspaceName: string
}

/** A completed run's launch configuration, reconstructed from what it recorded (SC-021). */
export interface LaunchConfiguration {
  readonly workflowId: string
  readonly pinned: PinnedLaunchValues
  readonly live: LiveDisplayNames
  /**
   * The profile has published a version since this run launched.
   *
   * Stated rather than left to be inferred, so the panel can say "launched under version 3; the
   * profile is now on version 7" instead of showing a version number nobody can interpret.
   */
  readonly profileEditedSinceLaunch: boolean
}

/** The pinned profile version, as this module reads it. */
export interface PinnedProfileVersionRow {
  readonly version: number
  readonly promptPreamble: string | null
  readonly lockedFields: readonly string[]
}

/** The pinned workspace version and the name its parent goes by now. */
export interface PinnedWorkspaceVersionRow {
  readonly version: number
  readonly workspaceName: string
}

/** The live profile row — its name, and where it has got to since. */
export interface LiveProfileRow {
  readonly name: string
  readonly currentVersionId: string | null
}

/** Everything {@link reconstructLaunchConfiguration} folds together. */
export interface LaunchConfigurationRows {
  readonly workflow: Workflow
  readonly pinnedProfileVersion: PinnedProfileVersionRow | undefined
  readonly pinnedWorkspaceVersion: PinnedWorkspaceVersionRow | undefined
  readonly liveProfile: LiveProfileRow | undefined
}

/**
 * Fold the rows into the configuration, deciding nothing else.
 *
 * Pure, and separate from the reads, so the one rule that matters — which field comes from which
 * row — is assertable without a database.
 *
 * @param rows - See {@link LaunchConfigurationRows}.
 */
export const reconstructLaunchConfiguration = (
  rows: LaunchConfigurationRows,
): LaunchConfiguration => {
  const { workflow, pinnedProfileVersion, pinnedWorkspaceVersion, liveProfile } = rows

  return {
    workflowId: workflow.id,

    pinned: {
      executionProfileId: workflow.executionProfileId,
      executionProfileVersionId: workflow.executionProfileVersionId,
      executionProfileVersion: pinnedProfileVersion?.version ?? null,
      workspaceVersionId: workflow.workspaceVersionId,
      workspaceVersion: pinnedWorkspaceVersion?.version ?? 0,
      setupBundleVersionId: workflow.setupBundleVersionId,
      workflowType: workflow.type,
      model: workflow.model,
      instanceType: workflow.instanceType,
      purchaseMode: workflow.purchaseMode,
      turnCap: workflow.turnCap,
      spendCap: workflow.spendCap,
      assembledPrompt: workflow.assembledPrompt,
      promptPreamble: pinnedProfileVersion?.promptPreamble ?? null,
      lockedFields: pinnedProfileVersion?.lockedFields ?? [],
    },

    live: {
      executionProfileName: liveProfile?.name ?? null,
      workspaceName: pinnedWorkspaceVersion?.workspaceName ?? '',
    },

    // An ad hoc run pinned no version, so there is nothing for an edit to have moved past.
    profileEditedSinceLaunch:
      workflow.executionProfileVersionId !== null &&
      liveProfile !== undefined &&
      liveProfile.currentVersionId !== workflow.executionProfileVersionId,
  }
}

/**
 * Read the pinned and live rows for one workflow and reconstruct its launch configuration.
 *
 * Takes a workflow the caller has **already** put through the scope check — every call site here is
 * downstream of `requireWorkflowInScope`, and passing the row rather than the id is what makes that
 * unavoidable. {@link readLaunchConfiguration} is the entry point for a caller holding only an id.
 *
 * @param reader - The pooled handle or a transaction.
 * @param workflow - The run, already read and already scoped.
 */
export const loadLaunchConfiguration = async (
  reader: LaunchConfigurationReader,
  workflow: Workflow,
): Promise<LaunchConfiguration> => {
  const pinnedProfileVersionId = workflow.executionProfileVersionId
  const liveProfileId = workflow.executionProfileId

  const [pinnedProfileVersion, pinnedWorkspaceVersion, liveProfile] = await Promise.all([
    // The pin. Keyed on `workflows.execution_profile_version_id` — never on the profile's current
    // version, which is the whole point of this module.
    pinnedProfileVersionId === null
      ? Promise.resolve(undefined)
      : reader
          .select({
            version: executionProfileVersions.version,
            promptPreamble: executionProfileVersions.promptPreamble,
            lockedFields: executionProfileVersions.lockedFields,
          })
          .from(executionProfileVersions)
          .where(eq(executionProfileVersions.id, pinnedProfileVersionId))
          .limit(1)
          .then(firstRow),

    // Also the pin: the workspace *version* the run recorded, with the parent's current name.
    reader
      .select({ version: workspaceVersions.version, workspaceName: workspaces.name })
      .from(workspaceVersions)
      .innerJoin(workspaces, eq(workspaces.id, workspaceVersions.workspaceId))
      .where(eq(workspaceVersions.id, workflow.workspaceVersionId))
      .limit(1)
      .then(firstRow),

    // The live row, read for its name and for how far it has moved — and for nothing else.
    liveProfileId === null
      ? Promise.resolve(undefined)
      : reader
          .select({
            name: executionProfiles.name,
            currentVersionId: executionProfiles.currentVersionId,
          })
          .from(executionProfiles)
          .where(eq(executionProfiles.id, liveProfileId))
          .limit(1)
          .then(firstRow),
  ])

  return reconstructLaunchConfiguration({
    workflow,
    pinnedProfileVersion,
    pinnedWorkspaceVersion,
    liveProfile,
  })
}

/**
 * One run's launch configuration, by id and **scoped** (FR-190).
 *
 * `requireWorkflowInScope` runs first, so an out-of-scope id and a nonexistent one leave here as
 * the same `NOT_FOUND` — a configuration read must not become the enumeration oracle the rest of
 * `./queries.ts` is careful not to be.
 */
export const readLaunchConfiguration = async (
  options: ScopedReadOptions & { readonly workflowId: string },
): Promise<LaunchConfiguration> => {
  const workflow = await requireWorkflowInScope(options)
  return loadLaunchConfiguration(options.db, workflow)
}
