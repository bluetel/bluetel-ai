import { describeTrpcError } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * What the screen says after a credential group changed (T026, FR-031, FR-060, FR-066, FR-067).
 *
 * "Saved" is not an answer to any of these. Every mutation here changes **what a future run may
 * work as**, and the consequence differs by act: creating a group changes nothing until credentials
 * are filed under it, disabling one withholds every member while interrupting nobody, and deleting
 * one is only ever permitted for a group that referred to nothing. So each notice names the
 * consequence rather than reporting that a row was written.
 *
 * The live-holder count is reported on every enable and disable, including when it is zero.
 * Disabling withholds members from **future** selection and evicts nothing (FR-006 applied
 * group-wide), so "3 runs keep the credential they are holding" and "no run was affected" are
 * answers to the same question — and an administrator who only ever sees the sentence when it is
 * non-zero stops reading it.
 */

/** What `create`, `rename` and `delete` all answer with. Inferred, never mirrored. */
export type CredentialGroupResult = RouterOutputs['admin']['credentialGroups']['create']

/** What `setEnabled` answers with — the group, and what it did not interrupt. */
export type CredentialGroupEnableResult = RouterOutputs['admin']['credentialGroups']['setEnabled']

/** The state readout and the sentence behind it. */
export interface CredentialGroupNotice {
  readonly readout: string
  readonly detail: string
}

/** Runs holding one of this group's credentials, as a phrase. */
const holders = (count: number): string =>
  count === 1 ? '1 run is holding one of its credentials' : `${String(count)} runs are holding one`

/**
 * Report a created group (FR-060).
 *
 * It says the group is empty and therefore hands nothing to anyone yet, because a group that
 * appeared and changed no run's behaviour would otherwise read as a control that did not work.
 */
export const describeCredentialGroupCreated = (
  result: CredentialGroupResult,
): CredentialGroupNotice => ({
  readout: 'created',
  detail: `Created the credential group ${result.name}. It is enabled and empty: a credential joins it at registration, and no profile draws on it until the group is attached to one.`,
})

/** Report a rename (FR-067). The trail keeps the previous name; the screen says what it is called now. */
export const describeCredentialGroupRenamed = (
  result: CredentialGroupResult,
): CredentialGroupNotice => ({
  readout: 'renamed',
  detail: `The group is now called ${result.name}. Earlier audit entries still name what it was called then, so the history stays joinable.`,
})

/** Report a disable or a re-enable (FR-066, FR-006 group-wide). */
export const describeCredentialGroupEnable = (
  result: CredentialGroupEnableResult,
): CredentialGroupNotice => ({
  readout: result.group.enabled ? 'enabled' : 'disabled',
  detail: result.group.enabled
    ? `${result.group.name} is enabled. Its credentials are selectable again for any execution profile attached to it; ${holders(result.liveHolderCount)}.`
    : `${result.group.name} is disabled. Every credential in it is withheld from future selection, and nothing running was interrupted — ${holders(result.liveHolderCount)}. Any enabled profile left with no usable group will be refused the next time somebody tries to enable it.`,
})

/**
 * Report a delete that was permitted (FR-066).
 *
 * It says why it was permitted — the group referred to nothing — because that is the one case FR-066
 * allows, and stating it is what makes the refusal an administrator sees on every other group read
 * as a rule rather than as an intermittent failure.
 */
export const describeCredentialGroupDeleted = (
  result: CredentialGroupResult,
): CredentialGroupNotice => ({
  readout: 'deleted',
  detail: `Deleted ${result.name}. It held no credential and no execution profile drew on it, which is the only state FR-066 permits a group to be deleted in. The row is kept, marked deleted, because its id appears on the audit trail.`,
})

/**
 * Describe a refused group change other than a refused delete.
 *
 * A refused delete has its own reader — see `./deletion-refusal.ts` — because FR-066 names which of
 * its two conditions applies and that must not be flattened into one sentence.
 */
export const describeCredentialGroupError = (error: unknown): FieldErrorContent =>
  describeTrpcError(error, {
    CONFLICT: {
      code: 'E_CREDENTIAL_GROUP_REFUSED',
      action: 'Nothing changed. Read the refusal, change what it names, and try again.',
    },
    NOT_FOUND: {
      code: 'E_CREDENTIAL_GROUP_NOT_FOUND',
      action: 'Reload the list — the credential group you were changing is no longer there.',
    },
  })
