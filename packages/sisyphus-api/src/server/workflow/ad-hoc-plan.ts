import { TRPCError } from '@trpc/server'

import type { ClaudeModel, PurchaseMode, WorkflowType } from '../../enums'
import type { StartAdHocInput } from '../../schemas'

/**
 * Turning the ad hoc launch form's values into the job spec a workflow row is written from
 * (FR-129, FR-187).
 *
 * Pure, for the same reason `./launch-plan.ts` is pure. An ad hoc launch has no profile standing
 * behind it, which means every rule that a profile version would otherwise have settled in advance
 * — what the caps must be, what a repository entered by hand is called on disk — is decided *here*,
 * on values a human typed a moment ago. That is exactly the code worth being able to test
 * exhaustively without a database.
 *
 * Nothing in this module reads a connection, a clock or a context.
 */

/** The job spec an ad hoc run is written from. The profile-shaped half of the form's values. */
export interface AdHocJobSpec {
  readonly workflowType: WorkflowType
  readonly model: ClaudeModel
  readonly instanceType: string
  readonly purchaseMode: PurchaseMode
  readonly turnCap: number | null
  readonly spendCap: string | null
}

/**
 * An autonomous run without both caps (FR-055, data-model.md → `workflows`).
 *
 * `BAD_REQUEST` naming the type rather than the missing field, because either cap on its own is
 * still refused and pointing at one of them would suggest the other is optional. An autonomous run
 * decides for itself when to stop; the caps are the only thing that says it has to.
 */
export const uncappedAutonomousError = (): TRPCError =>
  new TRPCError({
    code: 'BAD_REQUEST',
    message: 'An autonomous run needs both a turn cap and a spend cap before it can be started.',
  })

/**
 * Normalise the form's job-spec values, refusing the one combination that must not exist.
 *
 * Absent and explicitly null both become `null`: "no cap" is a real answer for a delegated run,
 * where a human is watching, and the two spellings of it must not produce different rows.
 *
 * @param input - The validated launch input.
 * @throws {@link uncappedAutonomousError} for an autonomous run missing either cap (FR-055).
 */
export const resolveAdHocJobSpec = (input: StartAdHocInput): AdHocJobSpec => {
  const turnCap = input.turnCap ?? null
  const spendCap = input.spendCap ?? null

  if (input.workflowType === 'autonomous' && (turnCap === null || spendCap === null)) {
    throw uncappedAutonomousError()
  }

  return {
    workflowType: input.workflowType,
    model: input.model,
    instanceType: input.instanceType,
    purchaseMode: input.purchaseMode,
    turnCap,
    spendCap,
  }
}

/** Characters a checkout directory may be named with. Everything else collapses to a hyphen. */
const UNSAFE_IN_A_PATH_SEGMENT = /[^A-Za-z0-9._-]+/g

/** What a repository is called when its URL yields nothing usable. Never blank, never `..`. */
const FALLBACK_SUBDIRECTORY = 'repository'

/** At least one letter or digit. `.`, `..` and `---` are not directory names, they are escapes. */
const HAS_A_NAME_IN_IT = /[A-Za-z0-9]/

/**
 * The checkout directory for a repository entered by hand.
 *
 * `workspace_entries.subdirectory` is not null and the form does not ask for one — asking would be
 * a tenth field for a value that is right nine times out of ten, and the entry is the only one in
 * an ad hoc workspace so there is nothing for it to collide with. So it is derived: the last path
 * segment, without its `.git` suffix, reduced to characters a path can hold.
 *
 * The result is required to contain a letter or a digit, which is what keeps `.`, `..` and `---`
 * out of it. A subdirectory has to resolve **inside** the pinned workspace root (FR-111), and a
 * derived value that could be `..` would make that a property of whatever URL somebody pasted.
 *
 * @param repositoryUrl - A git remote in any of the forms `repositoryUrlInput` admits.
 * @returns A non-empty, path-safe directory name that is never a traversal.
 */
export const deriveSubdirectory = (repositoryUrl: string): string => {
  const withoutSuffix = repositoryUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
  const lastSegment = withoutSuffix.split(/[/:]/).pop() ?? ''
  const safe = lastSegment.replace(UNSAFE_IN_A_PATH_SEGMENT, '-').replace(/^[-.]+|[-.]+$/g, '')

  return HAS_A_NAME_IN_IT.test(safe) ? safe : FALLBACK_SUBDIRECTORY
}

/**
 * The name of the private workspace a hand-entered repository is materialised into.
 *
 * `workspaces.name` is uniquely indexed and these rows are created without anybody choosing a
 * name, so the workspace's own id is folded in: two admins launching against the same repository
 * in the same second get two workspaces rather than a unique-violation from a launch form.
 *
 * The `ad hoc` prefix is what makes the row legible in the admin list six months later — it says
 * this workspace was a by-product of one launch rather than something somebody curated.
 *
 * @param repositoryUrl - The remote the entry points at.
 * @param workspaceId - The id the row is about to be inserted with.
 */
export const adHocWorkspaceName = (repositoryUrl: string, workspaceId: string): string =>
  `ad hoc: ${deriveSubdirectory(repositoryUrl)} (${workspaceId})`

/**
 * Whether the admin asked for the entered configuration to be kept as a profile (FR-129).
 *
 * A separate function from reading the field because the *decision* is what the form's one
 * remaining question comes down to, and it is worth being able to state it plainly: naming it
 * saves it, leaving it blank does not. There is no checkbox to get out of step with the name.
 *
 * @param saveAsProfile - The optional naming block from the launch input.
 */
export const willSaveAsProfile = (
  saveAsProfile: StartAdHocInput['saveAsProfile'],
): saveAsProfile is NonNullable<StartAdHocInput['saveAsProfile']> => saveAsProfile !== undefined
