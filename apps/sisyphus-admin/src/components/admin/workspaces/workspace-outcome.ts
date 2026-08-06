import { describeTrpcError } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * What the panel says after a workspace changed (T082, FR-031, FR-125, FR-128).
 *
 * ## Every notice names the version, because that is what changed
 *
 * "Saved" is a lie about this system. An edit did not save anything — it **published version n+1**
 * and left every run pinned to an earlier one exactly where it was. An admin who is told "saved"
 * will expect a run started a minute ago to pick up their change, and will file a bug when it does
 * not. So the sentence says which version was published and says, in words, that runs in flight are
 * unaffected.
 */

/** What `create`, `update` and `clone` all answer with. Inferred, never mirrored. */
export type PublishedWorkspaceResult = RouterOutputs['admin']['workspaces']['create']

/** What `setEnabled` answers with. */
export type WorkspaceEnableResult = RouterOutputs['admin']['workspaces']['setEnabled']

/** The state readout and the sentence behind it. */
export interface WorkspaceNotice {
  readonly readout: string
  readonly detail: string
}

const repositories = (count: number): string =>
  count === 1 ? '1 repository' : `${String(count)} repositories`

/**
 * Report a published version (FR-125).
 *
 * @param result - What the mutation answered with.
 * @param act - Which of the three writes it was, so the sentence is about what actually happened.
 */
export const describeWorkspacePublish = (
  result: PublishedWorkspaceResult,
  act: 'created' | 'edited' | 'cloned',
): WorkspaceNotice => {
  const version = result.published.version.version
  const count = result.published.entries.length

  const opening =
    act === 'created'
      ? `Created ${result.workspace.name} and published version 1 with ${repositories(count)}. It is disabled until you enable it.`
      : act === 'cloned'
        ? `Cloned into ${result.workspace.name} at version 1 with ${repositories(count)}. It is disabled until you enable it.`
        : `Published version ${String(version)} of ${result.workspace.name} with ${repositories(count)}.`

  const consequence =
    act === 'edited'
      ? ' Nothing already running changed: a workflow resolves the version it pinned at launch, so runs in flight stay on the version they started with.'
      : ''

  return { readout: `v${String(version)} published`, detail: `${opening}${consequence}` }
}

/** Report an enable or disable (FR-128). */
export const describeWorkspaceEnable = (result: WorkspaceEnableResult): WorkspaceNotice => ({
  readout: result.enabled ? 'enabled' : 'disabled',
  detail: result.enabled
    ? `${result.name} can now be pinned by a new execution profile version.`
    : `${result.name} can no longer be chosen. Runs already in flight against it are unaffected — disabling is what the platform offers instead of deletion, precisely so it never has to interrupt one.`,
})

/**
 * Describe a refused workspace change.
 *
 * `CONFLICT` is the one worth overriding. On this screen it is a duplicate name or an archived
 * workspace, and in both cases **nothing was published** — which is the fact an admin needs before
 * they press the button again.
 */
export const describeWorkspaceError = (error: unknown): FieldErrorContent =>
  describeTrpcError(error, {
    CONFLICT: {
      code: 'E_WORKSPACE_REFUSED',
      action: 'Nothing was published. Read the refusal, change what it names, and try again.',
    },
    NOT_FOUND: {
      code: 'E_WORKSPACE_NOT_FOUND',
      action: 'Reload the list — the workspace you were changing is no longer there.',
    },
  })
