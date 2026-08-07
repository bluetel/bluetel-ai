import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'

import type { SisyphusDatabase } from '../../db'
import { executionProfiles, executionProfileVersions, uuidV7 } from '../../db'
import type { SaveAsProfileInput } from '../../schemas'

import type { AdHocJobSpec } from './ad-hoc-plan'

/**
 * "Save this configuration as an execution profile" (FR-129).
 *
 * ## What it creates, and what it deliberately does not
 *
 * One `execution_profiles` row and its version 1, carrying exactly the job spec the run was
 * launched with, pinned to the same workspace version and setup bundle version. The profile is
 * created **disabled**, and nobody is granted it.
 *
 * That is not caution, it is FR-124: a profile may not be enabled until validation confirms its
 * bundle is enabled and every entry's repository and branch are reachable. Nothing has validated
 * this configuration — an admin typed it into a form a moment ago and the run it started has not
 * finished. A profile that arrived enabled would be a launch preset that skipped the one check
 * standing between a preset and a fleet of runs that cannot check out their repositories.
 *
 * No grants are issued either, for the same shape of reason: granting is its own separately
 * audited act (FR-184), and a profile that arrived with a grant attached would be access created
 * as a side effect of a launch.
 *
 * ## What it does not touch
 *
 * The workflow. Saving a profile does **not** make the run a profile launch — see the note on
 * `execution_profile_id` in `./start-ad-hoc.ts`. The two are linked in the timeline event and
 * nowhere else.
 */

/** Anything that can run this module's statements — the pooled handle or a transaction on it. */
export type ProfileWriter = Pick<SisyphusDatabase, 'select' | 'insert' | 'update'>

/**
 * The first row, honestly typed. `noUncheckedIndexedAccess` is off in this project, so `rows[0]`
 * is typed as present even when the result set is empty.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * A profile of that name already exists.
 *
 * Refused **before** the run is written, so a name collision costs a retype rather than leaving an
 * admin with a started run and a failed save they cannot repeat — the configuration would be gone
 * from the form by then. `execution_profiles.name` is uniquely indexed, so the alternative to
 * checking is a constraint violation surfacing as an internal error.
 */
export const duplicateProfileNameError = (name: string): TRPCError =>
  new TRPCError({
    code: 'CONFLICT',
    message: `An execution profile named ${name} already exists. Nothing was started; choose another name.`,
  })

/** What was saved, so the panel can link to it. */
export interface SavedProfile {
  readonly executionProfileId: string
  readonly executionProfileVersionId: string
  readonly name: string
}

/**
 * Create an execution profile from an ad hoc launch's configuration (FR-129).
 *
 * @param writer - The transaction the launch runs in. A refused launch must not leave a profile
 *   behind, and a failed profile save must not leave a run behind.
 * @param options - The naming from the form, the job spec the run resolved to, the versions it
 *   pinned, and the admin doing it.
 * @throws {@link duplicateProfileNameError} when the name is taken.
 */
export const saveConfigurationAsProfile = async (
  writer: ProfileWriter,
  options: {
    readonly saveAs: SaveAsProfileInput
    readonly spec: AdHocJobSpec
    readonly workspaceVersionId: string
    readonly setupBundleVersionId: string
    readonly actorUserId: string
  },
): Promise<SavedProfile> => {
  const { saveAs, spec, actorUserId } = options

  const existing = firstRow(
    await writer
      .select({ id: executionProfiles.id })
      .from(executionProfiles)
      .where(eq(executionProfiles.name, saveAs.name))
      .limit(1),
  )

  if (existing !== undefined) {
    throw duplicateProfileNameError(saveAs.name)
  }

  const executionProfileId = uuidV7()
  await writer.insert(executionProfiles).values({
    id: executionProfileId,
    name: saveAs.name,
    description: saveAs.description ?? null,
    enabled: false,
  })

  const executionProfileVersionId = uuidV7()
  await writer.insert(executionProfileVersions).values({
    id: executionProfileVersionId,
    executionProfileId,
    version: 1,
    workspaceVersionId: options.workspaceVersionId,
    setupBundleVersionId: options.setupBundleVersionId,
    model: spec.model,
    instanceType: spec.instanceType,
    purchaseMode: spec.purchaseMode,
    turnCap: spec.turnCap,
    spendCap: spec.spendCap,
    defaultWorkflowType: spec.workflowType,
    // The prompt that was launched is **not** copied here. It is this ticket's instructions, not
    // standing context, and a preamble is prepended to every future launch on the profile
    // (FR-157) — so copying it would make every later run repeat one afternoon's work item.
    promptPreamble: null,
    // Nothing is locked. Locking is a statement about what holders may not change (FR-123), and a
    // profile that has never been granted to anybody has no holders to have an opinion about.
    lockedFields: [],
    createdByUserId: actorUserId,
  })

  await writer
    .update(executionProfiles)
    .set({ currentVersionId: executionProfileVersionId })
    .where(eq(executionProfiles.id, executionProfileId))

  return { executionProfileId, executionProfileVersionId, name: saveAs.name }
}
