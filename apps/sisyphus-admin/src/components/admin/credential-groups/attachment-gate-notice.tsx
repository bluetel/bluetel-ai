import { FieldError } from '@sisyphus-admin/components/ui'

import { describeUsableAttachments, evaluateAttachmentGate } from './attachment-gate'
import type { ProfileAttachment } from './attachment-order'

/**
 * FR-065's verdict, rendered above the list it is about (T027).
 *
 * ## It takes no error and no pending state, and that is the requirement
 *
 * Every other refusal on these screens arrives as a prop: something was submitted, the server said
 * no, the panel shows what it said. This one takes **only the attachments**. It is a function of the
 * configuration as it currently stands, so it renders the moment the list is read — before anything
 * is pressed, and whether or not anything is ever pressed. That is precisely what "refused at
 * configuration time rather than failing at launch" asks for: the administrator editing the
 * attachments is told, while they are editing them, that this profile cannot be enabled and what is
 * missing. A version of this component that needed a rejected mutation to say the same sentence
 * would have moved the discovery to the save, which is the outcome FR-065 exists to prevent.
 *
 * ## The passing case is stated too
 *
 * "Nothing is wrong" and "nothing has loaded" look identical, so the component says which — and the
 * passing sentence is also where FR-064's selection rule is spelled out against the order actually
 * attached, which is the one place it can be read as a fact rather than as documentation.
 */

interface AttachmentGateNoticeProps {
  /** The profile's attachments as last read, in preference order. */
  attachments: readonly ProfileAttachment[]
}

export const AttachmentGateNotice = ({ attachments }: AttachmentGateNoticeProps) => {
  const failure = evaluateAttachmentGate(attachments)

  if (failure === undefined) {
    return <p className="type-data-mono text-graphite">{describeUsableAttachments(attachments)}</p>
  }

  return (
    <div className="gap-hair flex flex-col" aria-label="Why this profile cannot be enabled">
      <FieldError code={failure.error.code} action={failure.error.action} />
      <p className="type-data-mono text-graphite">{failure.detail}</p>
    </div>
  )
}
