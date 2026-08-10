import type { FieldErrorContent } from '@sisyphus-admin/components/ui'

import type { ProfileAttachment } from './attachment-order'

/**
 * FR-065, read off the attachments themselves so it is stated **at configuration time** (T027).
 *
 * ## Why this is not left to the save
 *
 * The router already refuses to enable a profile with no usable credential group — that is T023's
 * `credentialGroupAttachmentCheck`, and it is the authority. But a refusal that only ever arrives
 * as a bounced save is a refusal an administrator meets *after* deciding they were finished: they
 * press Enable on the profiles screen, are told the attachment is missing, and have to come back
 * here to fix it. FR-065's own wording is "refused **at configuration time** as unlaunchable,
 * naming the missing attachment, rather than failing at launch", and the same argument that puts
 * the check before the launch puts this sentence before the save. It is rendered where the
 * attachments are edited, permanently, from the moment the list is read — no mutation, no error
 * state, nothing pressed.
 *
 * ## This is a preview of the rule, never a second copy of it
 *
 * The verdicts below deliberately mirror `credentialGroupAttachmentCheck` in
 * `packages/sisyphus-api/src/server/admin/profile-gate.ts`, and they cannot import it: that module
 * sits behind `@bluetel-ai/sisyphus-api/server`, which carries Drizzle and the `postgres` driver
 * and is not safe in a browser bundle. What stops the two drifting into disagreement is that the
 * server keeps deciding — this panel never enables anything and never suppresses a refusal on the
 * strength of its own verdict. If they ever disagree, the administrator sees a warning that turns
 * out to be unnecessary, or a save that is refused with the server's own sentence. Neither silently
 * lets an unlaunchable profile through, which is the failure that would matter.
 *
 * ## Why "attached" and "usable" are different failures
 *
 * A group that has been disabled or deleted withholds every member from selection (FR-006 applied
 * group-wide), so a profile attached only to such groups has an attachment and no capacity — the
 * same launch behaviour as one with none. Reporting them identically would send one administrator
 * to attach a group when what they needed was to re-enable the one already there. The server states
 * them as two sentences; so does this.
 */

/** Which way the gate fails. Mirrors the two verdicts `credentialGroupAttachmentCheck` produces. */
export const ATTACHMENT_GATE_REASONS = ['none_attached', 'none_usable'] as const

export type AttachmentGateReason = (typeof ATTACHMENT_GATE_REASONS)[number]

/** What to do about each, and where. Never a restatement of what is wrong. */
const ACTIONS: Readonly<Record<AttachmentGateReason, FieldErrorContent>> = {
  none_attached: {
    code: 'E_PROFILE_NO_CREDENTIAL_GROUP',
    action:
      'Attach at least one credential group below. Until then the platform refuses to enable this profile — the refusal is here rather than at launch so nobody discovers it with a run already accepted.',
  },
  none_usable: {
    code: 'E_PROFILE_CREDENTIAL_GROUPS_UNAVAILABLE',
    action:
      'Re-enable one of the groups listed below on the credential groups screen, or attach a group that is enabled. The attachment is present, so attaching another copy of it will not help.',
  },
}

/** The gate's verdict when it fails. `undefined` from {@link evaluateAttachmentGate} means it passed. */
export interface AttachmentGateFailure {
  readonly reason: AttachmentGateReason
  /** What is wrong, in the same terms the server states it in. */
  readonly detail: string
  /** A code and a next action. What to do about it. */
  readonly error: FieldErrorContent
}

/** Attachments a run could actually be given a credential from. */
export const usableAttachments = (
  attachments: readonly ProfileAttachment[],
): readonly ProfileAttachment[] =>
  attachments.filter((attachment) => attachment.enabled && attachment.archivedAt === null)

/**
 * Whether this set of attachments leaves the profile launchable (FR-065).
 *
 * @param attachments - The profile's attachments as last read, in preference order.
 * @returns The failure to render inline, or `undefined` when the profile has capacity it is
 *   permitted to draw on.
 */
export const evaluateAttachmentGate = (
  attachments: readonly ProfileAttachment[],
): AttachmentGateFailure | undefined => {
  if (attachments.length === 0) {
    return {
      reason: 'none_attached',
      detail:
        'This execution profile has no attached credential group, so a run launched from it would have no agent identity it is permitted to work as.',
      error: ACTIONS.none_attached,
    }
  }

  if (usableAttachments(attachments).length === 0) {
    return {
      reason: 'none_usable',
      detail: `Every credential group attached to this execution profile is unavailable (${attachments
        .map((attachment) => attachment.name)
        .join(', ')}), so no credential could ever be selected for a run launched from it.`,
      error: ACTIONS.none_usable,
    }
  }

  return undefined
}

/**
 * What the panel says when the gate passes.
 *
 * Stated rather than left as the absence of a warning: "nothing is wrong" and "nothing has loaded"
 * look identical, and this sentence is also where the FR-064 selection rule is spelled out against
 * the order the administrator is actually looking at.
 */
export const describeUsableAttachments = (attachments: readonly ProfileAttachment[]): string => {
  const usable = usableAttachments(attachments)
  const first = usable[0]?.name ?? ''

  return `${String(usable.length)} of ${String(attachments.length)} attached ${attachments.length === 1 ? 'group is' : 'groups are'} usable. A run launched from this profile is given a credential from ${first} where one is available, and from the next usable group in the order below where it is not.`
}
