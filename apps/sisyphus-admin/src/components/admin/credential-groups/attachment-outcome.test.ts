import { describe, expect, it } from 'vitest'

import type { ProfileAttachment } from './attachment-order'
import type { ProfileAttachmentsResult } from './attachment-outcome'
import {
  describeAttached,
  describeAttachmentError,
  describeDetached,
  describeOrder,
  describeReordered,
} from './attachment-outcome'

const attachment = (position: number, name: string): ProfileAttachment => ({
  id: `attachment-${name}`,
  credentialGroupId: `group-${name}`,
  name,
  enabled: true,
  archivedAt: null,
  position,
})

const result = (...attachments: readonly ProfileAttachment[]): ProfileAttachmentsResult => ({
  executionProfileId: 'profile-1',
  attachments,
})

describe('reporting an attachment change (FR-062, FR-064)', () => {
  it('says where an appended group landed, because appended is not what a replacement wants', () => {
    const notice = describeAttached(
      result(attachment(1, 'Payments'), attachment(2, 'Reserve')),
      'Reserve',
    )

    expect(notice.detail).toContain('last in preference order')
    expect(notice.detail).toContain('move it earlier')
  })

  it('reads the order out after a reorder, in the terms selection uses', () => {
    const notice = describeReordered(result(attachment(1, 'Reserve'), attachment(2, 'Payments')))

    expect(notice.detail).toContain('Reserve, then Payments')
    expect(notice.detail).toContain('least recently used')
  })

  it('says a detach that emptied the list leaves the profile unable to be enabled (FR-065)', () => {
    const notice = describeDetached(result(), 'Payments')

    expect(notice.detail).toContain('no credential group at all')
    expect(notice.detail).toContain('cannot be enabled until one is attached')
  })

  it('says a run already under way keeps the credential it was given', () => {
    expect(describeDetached(result(attachment(1, 'Reserve')), 'Payments').detail).toContain(
      'keep the credential they were given',
    )
  })

  it('states an empty order as a fact rather than as a blank', () => {
    expect(describeOrder(result())).toBe('No credential group is attached.')
  })
})

describe('telling the three CONFLICT refusals apart', () => {
  it('reads the FR-065 detach refusal as the one fixed by attaching a replacement', () => {
    const described = describeAttachmentError({
      data: { code: 'CONFLICT' },
      message:
        'Detaching Payments would leave the enabled execution profile Payments — delegated unlaunchable:\n- this execution profile has no attached credential group\nAttach another credential group first, or disable the profile.',
    })

    expect(described.code).toBe('E_PROFILE_DETACH_LAST_GROUP')
    expect(described.action).toContain('disable the profile')
  })

  it('reads a stale reorder as the one fixed by a reload, not by trying again', () => {
    const described = describeAttachmentError({
      data: { code: 'CONFLICT' },
      message:
        'The order given does not match the 2 credential groups currently attached to Payments — delegated. Reload the profile and try again.',
    })

    expect(described.code).toBe('E_CREDENTIAL_GROUP_ORDER_STALE')
    expect(described.action).toContain('Reload')
  })

  it('falls back to the ordinary refusal for a conflict it does not recognise', () => {
    expect(
      describeAttachmentError({
        data: { code: 'CONFLICT' },
        message: 'The credential group Payments has been deleted and cannot be used.',
      }).code,
    ).toBe('E_CREDENTIAL_GROUP_ATTACH_REFUSED')
  })

  it('never answers without a code and a next action', () => {
    const described = describeAttachmentError(new Error('socket hang up'))

    expect(described.code).toBe('E_UNEXPECTED')
    expect(described.action).not.toBe('')
  })
})
