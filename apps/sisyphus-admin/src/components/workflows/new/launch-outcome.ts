import { describeTrpcError } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * What the panel says after an ad hoc launch (T064a, FR-031, FR-040).
 *
 * The sentence has to carry one thing the operator will otherwise get wrong: **nothing has been
 * provisioned**. `startAdHoc` writes a `queued` row and returns — the control plane admits it
 * afterwards, under the concurrency ceiling — so a launch that says "started" would have an
 * operator watching for output that cannot arrive yet, and a launch that said nothing would leave
 * them unable to tell waiting from stuck. The queue position is the difference between those two,
 * which is why it is in the readout rather than buried in the detail.
 */

/** What `workflow.startAdHoc` answers with. Inferred, never mirrored. */
export type AdHocLaunchResult = RouterOutputs['workflow']['startAdHoc']

/** The state readout and the sentence behind it. */
export interface LaunchNotice {
  readonly readout: string
  readonly detail: string
}

const entries = (count: number): string =>
  count === 1 ? '1 repository' : `${String(count)} repositories`

/**
 * Report a completed launch.
 *
 * Every consequence the request had is stated, including the two side effects an operator did not
 * ask for in so many words: the private workspace a hand-entered repository produced, and the
 * profile that was saved **disabled**. A profile that appeared and could not be launched on would
 * otherwise read as a bug rather than as FR-124.
 *
 * @param result - What the mutation answered with.
 */
export const describeLaunch = (result: AdHocLaunchResult): LaunchNotice => {
  const detail = [
    `Queued at position ${String(result.queuePosition)}, checking out ${entries(result.entries.length)}. Nothing has been provisioned yet — the control plane admits queued runs under the platform concurrency ceiling.`,
    result.materialisedWorkspace
      ? 'The repository you entered was kept as a private workspace so the run can say what it checked out. It is disabled, so it will not appear in the picker.'
      : undefined,
    result.savedProfile === undefined
      ? undefined
      : `Saved the configuration as “${result.savedProfile.name}”. It is disabled and granted to nobody until its repositories and setup bundle have been validated.`,
  ]
    .filter((line) => line !== undefined)
    .join(' ')

  return { readout: `queued ${String(result.queuePosition)}`, detail }
}

/**
 * Describe a refused launch.
 *
 * `CONFLICT` is the one worth overriding. On this form it is never a concurrent edit — it is a
 * disabled bundle, a disabled workspace or a profile name already taken, and in all three cases
 * **nothing was started**, which is the fact an operator needs before they consider pressing the
 * button again.
 */
export const describeLaunchError = (error: unknown): FieldErrorContent =>
  describeTrpcError(error, {
    CONFLICT: {
      code: 'E_LAUNCH_REFUSED',
      action: 'Nothing was started. Read the refusal, change what it names, and launch again.',
    },
    NOT_FOUND: {
      code: 'E_LAUNCH_TARGET_NOT_FOUND',
      action: 'Reload the page — a workspace or setup bundle you chose is no longer there.',
    },
    FORBIDDEN: {
      code: 'E_ADMIN_REQUIRED',
      action: 'Ad hoc launching is admin-only. Ask an admin, or launch from a profile you hold.',
    },
  })

/** What `workflow.start` answers with. Inferred, never mirrored. */
export type ProfileLaunchResult = RouterOutputs['workflow']['start']

/**
 * Report a completed profile launch (T080, FR-040, FR-122, FR-126).
 *
 * Says the same "nothing has been provisioned" the ad hoc notice says, and adds the one fact this
 * path has that the other does not: **which profile version the run is pinned to**. FR-126 makes
 * that a property of the run rather than of the profile, and an operator who edits the profile ten
 * minutes later needs to have been told once that this run will not follow the edit.
 *
 * @param result - What the mutation answered with.
 * @param profileVersion - The version number the form was showing when it submitted.
 */
export const describeProfileLaunch = (
  result: ProfileLaunchResult,
  profileVersion: number | undefined,
): LaunchNotice => ({
  readout: `queued ${String(result.queuePosition)}`,
  detail: [
    `Queued at position ${String(result.queuePosition)}, checking out ${entries(result.entries.length)}. Nothing has been provisioned yet — the control plane admits queued runs under the platform concurrency ceiling.`,
    profileVersion === undefined
      ? undefined
      : `The run is pinned to version ${String(profileVersion)} of the profile, so a later edit to that profile will not change what this run does.`,
  ]
    .filter((line) => line !== undefined)
    .join(' '),
})

/**
 * Describe a refused profile launch.
 *
 * `NOT_FOUND` is the one worth overriding, and its wording is load-bearing under FR-190. A profile
 * the caller does not hold, a profile that does not exist and a profile with no published version
 * are the **same** refusal by design — a response that told them apart would answer "does this
 * profile id exist?" for an id they were never shown. So the action says the profile is not
 * available to them and stops there; it must never say "you do not have permission".
 */
export const describeProfileLaunchError = (error: unknown): FieldErrorContent =>
  describeTrpcError(error, {
    NOT_FOUND: {
      code: 'E_PROFILE_NOT_AVAILABLE',
      action:
        'Reload the list and choose again — that execution profile is not one you can launch on.',
    },
    CONFLICT: {
      code: 'E_LAUNCH_REFUSED',
      action: 'Nothing was started. Read the refusal, change what it names, and launch again.',
    },
    BAD_REQUEST: {
      code: 'E_LAUNCH_OVERRIDE_REFUSED',
      action:
        'Nothing was started. Put the profile’s own value back in the field it names and launch again.',
    },
  })

/**
 * The list of launchable profiles could not be read.
 *
 * Worded without reference to a role, deliberately. Under FR-190 the panel must never explain an
 * absence by naming a permission — "you are not an admin" would be a statement about what exists
 * behind the refusal. What the operator can act on is the same either way: somebody has to grant
 * them a profile.
 */
export const PROFILE_CATALOGUE_UNAVAILABLE: FieldErrorContent = {
  code: 'E_PROFILE_CATALOGUE_UNAVAILABLE',
  action: 'Ask an admin to grant you an execution profile, then reload this page.',
}

/**
 * Describe a failure to read the list of launchable profiles.
 *
 * Separate from a refused launch because it is a different next action: nothing was attempted, and
 * what the operator needs is either a reload or somebody to grant them a profile.
 */
export const describeProfileCatalogueError = (error: unknown): FieldErrorContent =>
  describeTrpcError(error, {
    NOT_FOUND: PROFILE_CATALOGUE_UNAVAILABLE,
    FORBIDDEN: PROFILE_CATALOGUE_UNAVAILABLE,
  })
