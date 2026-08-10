import { describe, expect, it } from 'vitest'

import { describeUsableAttachments, evaluateAttachmentGate } from './attachment-gate'
import type { ProfileAttachment } from './attachment-order'

const attachment = (patch: Partial<ProfileAttachment> = {}): ProfileAttachment => ({
  id: 'attachment-1',
  credentialGroupId: 'group-1',
  name: 'Payments',
  enabled: true,
  archivedAt: null,
  position: 1,
  ...patch,
})

/**
 * The verdicts here are asserted against the sentences
 * `packages/sisyphus-api/src/server/admin/profile-gate.ts` states them in. That is the point of the
 * module: the administrator reads the same diagnosis before the save that the server would give
 * them after it, so the two never look like different problems.
 */
describe('the FR-065 gate, evaluated at configuration time', () => {
  it('fails a profile with no attachment at all, without anything having been submitted', () => {
    const failure = evaluateAttachmentGate([])

    expect(failure?.reason).toBe('none_attached')
    expect(failure?.detail).toContain('no attached credential group')
    expect(failure?.detail).toContain('no agent identity it is permitted to work as')
  })

  it('names attaching a group as the fix, which is the missing attachment FR-065 asks it to name', () => {
    expect(evaluateAttachmentGate([])?.error.code).toBe('E_PROFILE_NO_CREDENTIAL_GROUP')
    expect(evaluateAttachmentGate([])?.error.action).toContain('Attach at least one credential')
  })

  it('says the refusal is here rather than at launch, which is the requirement', () => {
    expect(evaluateAttachmentGate([])?.error.action).toContain('rather than at launch')
  })

  it('fails a profile whose only attached groups are unusable, and says so differently', () => {
    const failure = evaluateAttachmentGate([
      attachment({ enabled: false }),
      attachment({
        credentialGroupId: 'group-2',
        name: 'Legacy',
        archivedAt: new Date(),
        position: 2,
      }),
    ])

    expect(failure?.reason).toBe('none_usable')
    expect(failure?.detail).toContain('Payments, Legacy')
    expect(failure?.error.action).toContain('Re-enable')
  })

  it('gives the two failures different codes, because they are fixed in different places', () => {
    const none = evaluateAttachmentGate([])
    const unusable = evaluateAttachmentGate([attachment({ enabled: false })])

    expect(none?.error.code).not.toBe(unusable?.error.code)
  })

  it('passes a profile with one usable group, even when an unusable one sits beside it', () => {
    expect(
      evaluateAttachmentGate([
        attachment({ enabled: false }),
        attachment({ credentialGroupId: 'group-2', name: 'Reserve', position: 2 }),
      ]),
    ).toBeUndefined()
  })
})

describe('what the panel says when the gate passes', () => {
  it('states the FR-064 selection rule against the order actually attached', () => {
    const detail = describeUsableAttachments([
      attachment(),
      attachment({ credentialGroupId: 'group-2', name: 'Reserve', position: 2 }),
    ])

    expect(detail).toContain('2 of 2')
    expect(detail).toContain('Payments')
    expect(detail).toContain('next usable group in the order below')
  })

  it('counts the usable groups rather than the attached ones', () => {
    expect(
      describeUsableAttachments([
        attachment({ enabled: false }),
        attachment({ credentialGroupId: 'group-2', name: 'Reserve', position: 2 }),
      ]),
    ).toContain('1 of 2')
  })
})
