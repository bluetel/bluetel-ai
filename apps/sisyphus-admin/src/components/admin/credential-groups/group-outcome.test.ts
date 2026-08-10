import { describe, expect, it } from 'vitest'

import type { CredentialGroupResult } from './group-outcome'
import {
  describeCredentialGroupCreated,
  describeCredentialGroupDeleted,
  describeCredentialGroupEnable,
  describeCredentialGroupError,
  describeCredentialGroupRenamed,
} from './group-outcome'

const group = (patch: Partial<CredentialGroupResult> = {}): CredentialGroupResult => ({
  id: 'group-1',
  name: 'Payments',
  description: null,
  enabled: true,
  createdByUserId: 'admin-1',
  archivedAt: null,
  createdAt: new Date('2026-02-01T09:30:00.000Z'),
  updatedAt: new Date('2026-02-01T09:30:00.000Z'),
  ...patch,
})

describe('what the screen says after a group changed (FR-060, FR-066, FR-067)', () => {
  it('says a new group is empty, so it does not read as a control that did nothing', () => {
    expect(describeCredentialGroupCreated(group()).detail).toContain('enabled and empty')
  })

  it('says a rename leaves the earlier trail entries readable', () => {
    expect(describeCredentialGroupRenamed(group({ name: 'Payments — EU' })).detail).toContain(
      'Payments — EU',
    )
  })
})

describe('disabling as the alternative FR-066 offers', () => {
  it('says every member is withheld and nothing running was interrupted', () => {
    const notice = describeCredentialGroupEnable({
      group: group({ enabled: false }),
      liveHolderCount: 3,
    })

    expect(notice.readout).toBe('disabled')
    expect(notice.detail).toContain('withheld from future selection')
    expect(notice.detail).toContain('3 runs are holding one')
  })

  it('reports the holder count when it is zero too, so the sentence is always read', () => {
    expect(
      describeCredentialGroupEnable({ group: group({ enabled: false }), liveHolderCount: 0 })
        .detail,
    ).toContain('0 runs are holding one')
  })

  it('warns that an enabled profile left with nothing usable is refused at its next enable (FR-065)', () => {
    expect(
      describeCredentialGroupEnable({ group: group({ enabled: false }), liveHolderCount: 0 })
        .detail,
    ).toContain('refused the next time')
  })

  it('says a re-enabled group is selectable again', () => {
    const notice = describeCredentialGroupEnable({ group: group(), liveHolderCount: 1 })

    expect(notice.readout).toBe('enabled')
    expect(notice.detail).toContain('selectable again')
  })
})

describe('a delete that was permitted', () => {
  it('says why it was permitted, so every refusal reads as the rule rather than as a fault', () => {
    const notice = describeCredentialGroupDeleted(group({ archivedAt: new Date() }))

    expect(notice.detail).toContain('held no credential')
    expect(notice.detail).toContain('no execution profile drew on it')
  })
})

describe('describing an ordinary refusal', () => {
  it('gives a quotable code and a next action, never a dead end', () => {
    const described = describeCredentialGroupError({ data: { code: 'CONFLICT' } })

    expect(described.code).toBe('E_CREDENTIAL_GROUP_REFUSED')
    expect(described.action).not.toBe('')
  })

  it('sends a vanished group to a reload rather than to a retry', () => {
    expect(describeCredentialGroupError({ data: { code: 'NOT_FOUND' } }).action).toContain('Reload')
  })
})
