import { describeTrpcError, readTrpcErrorCode } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

import { ordinal } from './attachment-order'

/**
 * What the profile's credential-group screen says after an attachment changed (T027, FR-062,
 * FR-065, FR-067).
 *
 * Every notice names the **order**, not the row. Attaching appends, so the group an administrator
 * just added is the one tried last — which is usually what they wanted for a fallback pool and
 * exactly not what they wanted for a replacement primary. Reporting "attached" without saying where
 * would leave the second case to be discovered by a run drawing from the wrong pool, which is a
 * failure nothing on this screen would ever show.
 */

/** What `attach`, `detach` and `reorder` all answer with — the profile's whole order, after the change. */
export type ProfileAttachmentsResult = RouterOutputs['admin']['credentialGroups']['forProfile']

/** The state readout and the sentence behind it. */
export interface AttachmentNotice {
  readonly readout: string
  readonly detail: string
}

/** The order as a sentence: the names, in the order selection walks them. */
export const describeOrder = (result: ProfileAttachmentsResult): string =>
  result.attachments.length === 0
    ? 'No credential group is attached.'
    : `Preference order is now ${result.attachments.map((attachment) => attachment.name).join(', then ')}.`

/** Report an attach — appended, so it says where it landed (FR-062). */
export const describeAttached = (
  result: ProfileAttachmentsResult,
  name: string,
): AttachmentNotice => {
  const total = result.attachments.length
  const position = result.attachments.find((attachment) => attachment.name === name)?.position

  return {
    readout: `attached ${String(total)}`,
    detail:
      position === undefined
        ? `${name} is attached. ${describeOrder(result)}`
        : `${name} is attached ${position === total ? 'last' : ordinal(position)} in preference order, ${String(position)} of ${String(total)}. Groups are appended, so it is tried after every group above it — move it earlier if a run should prefer it.`,
  }
}

/**
 * Report a detach (FR-062, FR-065).
 *
 * A detach that empties the list is not refused for a **disabled** profile — the router permits it,
 * because an administrator reorganising a retired profile must not be made to attach a group they
 * do not want in order to remove one they do. So the notice says what state that leaves the profile
 * in, and the inline gate above the list keeps saying it afterwards.
 */
export const describeDetached = (
  result: ProfileAttachmentsResult,
  name: string,
): AttachmentNotice => ({
  readout: `attached ${String(result.attachments.length)}`,
  detail:
    result.attachments.length === 0
      ? `${name} is detached. This profile now draws on no credential group at all, so it cannot be enabled until one is attached — runs already under way keep the credential they were given.`
      : `${name} is detached. ${describeOrder(result)} Runs already under way keep the credential they were given.`,
})

/** Report a reorder, in the terms FR-064 defines the order in. */
export const describeReordered = (result: ProfileAttachmentsResult): AttachmentNotice => ({
  readout: 'reordered',
  detail: `${describeOrder(result)} Selection takes the first of those with an available credential, and the least recently used credential within it.`,
})

/** Read the message off whatever the mutation hook handed back. */
const readMessage = (error: unknown): string => {
  if (typeof error !== 'object' || error === null) return ''
  const { message } = error as { message?: unknown }
  return typeof message === 'string' ? message : ''
}

/**
 * Describe a refused attachment change.
 *
 * Three refusals arrive here as `CONFLICT` and they mean different things, so they are told apart by
 * the sentence the router opened with rather than flattened into "that did not work":
 *
 * 1. **A detach the FR-065 gate refused** — it would leave an *enabled* profile with nothing to draw
 *    on. The fix is to attach the replacement first, or to disable the profile.
 * 2. **A reorder built from a stale list** — somebody attached or detached a group in between, and
 *    the router refuses rather than applying a shuffle nobody asked for. The fix is a reload.
 * 3. **Anything else**, including an archived group being attached.
 */
export const describeAttachmentError = (error: unknown): FieldErrorContent => {
  const message = readMessage(error)

  if (readTrpcErrorCode(error) === 'CONFLICT') {
    if (message.startsWith('Detaching ')) {
      return {
        code: 'E_PROFILE_DETACH_LAST_GROUP',
        action:
          'Nothing was detached. Attach the group that replaces it first, or disable the profile — an enabled profile is not allowed to reach the point of having no identity to work as.',
      }
    }

    if (message.includes('does not match')) {
      return {
        code: 'E_CREDENTIAL_GROUP_ORDER_STALE',
        action:
          'Nothing was reordered. Reload this screen — somebody attached or detached a group while you were reordering, so the order you sent is no longer the set that is attached.',
      }
    }
  }

  return describeTrpcError(error, {
    CONFLICT: {
      code: 'E_CREDENTIAL_GROUP_ATTACH_REFUSED',
      action: 'Nothing changed. Read the refusal, change what it names, and try again.',
    },
    NOT_FOUND: {
      code: 'E_CREDENTIAL_GROUP_NOT_FOUND',
      action:
        'Reload this screen — the execution profile or the credential group you named is no longer there.',
    },
  })
}
