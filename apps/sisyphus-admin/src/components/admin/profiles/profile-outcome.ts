import { describeTrpcError } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * What the panel says after an execution profile changed (T082, FR-031, FR-124, FR-125, FR-128).
 *
 * "Saved" is a lie about this system, exactly as it is about workspaces. An edit publishes version
 * n+1 and leaves every run pinned to an earlier one where it was, so the sentence names the version
 * and says in words that runs in flight are unaffected.
 */

/** What `create`, `update` and `clone` all answer with. Inferred, never mirrored. */
export type PublishedProfileResult = RouterOutputs['admin']['profiles']['create']

/** What `setEnabled` answers with. */
export type ProfileEnableResult = RouterOutputs['admin']['profiles']['setEnabled']

/** What `references` answers with. */
export type ProfileReferencesResult = RouterOutputs['admin']['profiles']['references']

/** The state readout and the sentence behind it. */
export interface ProfileNotice {
  readonly readout: string
  readonly detail: string
}

/**
 * Report a published version (FR-124, FR-125).
 *
 * A newly created or cloned profile arrives **disabled and granted to nobody**, and saying so is
 * the point: a profile that appeared and could not be launched on would otherwise read as a bug
 * rather than as the FR-124 gate doing its job.
 */
export const describeProfilePublish = (
  result: PublishedProfileResult,
  act: 'created' | 'edited' | 'cloned',
): ProfileNotice => {
  const version = result.version.version

  const opening =
    act === 'edited'
      ? `Published version ${String(version)} of ${result.profile.name}.`
      : `${act === 'created' ? 'Created' : 'Cloned into'} ${result.profile.name} at version 1. It is disabled and granted to nobody until its repositories and setup bundle have been validated.`

  const consequence =
    act === 'edited'
      ? ' Nothing already running changed: a workflow records the profile version it launched from, so runs in flight stay on the version they started with.'
      : ''

  return { readout: `v${String(version)} published`, detail: `${opening}${consequence}` }
}

/**
 * Report a passing enable, or a disable (FR-124, FR-128).
 *
 * An enable that passed is worth reporting as a *check that ran*, not just as a flag that flipped:
 * the platform has confirmed the bundle is enabled and every repository reachable, and an admin who
 * is told only "enabled" has no way to know that happened.
 */
export const describeProfileEnable = (result: ProfileEnableResult): ProfileNotice => ({
  readout: result.profile.enabled ? 'enabled' : 'disabled',
  detail: result.profile.enabled
    ? `${result.profile.name} is enabled. Its setup bundle is enabled and every repository in the workspace version it pins was reachable at the moment it was checked.`
    : `${result.profile.name} can no longer be launched on. Runs already in flight are unaffected — disabling is what the platform offers instead of deletion, precisely so it never has to interrupt one.`,
})

/** What still points at a profile, as a sentence (FR-128). */
export const describeProfileReferences = (references: ProfileReferencesResult): string =>
  [
    `${String(references.liveGrantCount)} live ${references.liveGrantCount === 1 ? 'grant' : 'grants'}`,
    `${String(references.integrations.length)} ${references.integrations.length === 1 ? 'integration' : 'integrations'}`,
    `${String(references.activeWorkflowCount)} of ${String(references.totalWorkflowCount)} runs still non-terminal`,
    references.archivable
      ? 'nothing depends on it, so it may be archived'
      : 'something depends on it, so it may only be disabled',
  ].join(' · ')

/**
 * Describe a refused profile change other than a failed enable.
 *
 * A failed enable has its own reader — see `./enable-refusal.ts` — because the FR-124 gate names
 * every failing element and that list must not be flattened into one sentence.
 */
export const describeProfileError = (error: unknown): FieldErrorContent =>
  describeTrpcError(error, {
    CONFLICT: {
      code: 'E_PROFILE_REFUSED',
      action: 'Nothing was published. Read the refusal, change what it names, and try again.',
    },
    NOT_FOUND: {
      code: 'E_PROFILE_TARGET_NOT_FOUND',
      action:
        'Reload the page — the profile, workspace version or setup bundle version you named is no longer there.',
    },
  })
