import { describe, expect, it } from 'vitest'

import type { CredentialGroupListItem } from './group-listing'
import {
  ABSENT,
  deletionBlockersFromCounts,
  describeDeletionBlocker,
  toCredentialGroupReadouts,
} from './group-listing'

const group = (patch: Partial<CredentialGroupListItem> = {}): CredentialGroupListItem => ({
  id: 'group-1',
  name: 'Payments',
  description: 'The payments pool',
  enabled: true,
  archivedAt: null,
  createdAt: new Date('2026-02-01T09:30:11.000Z'),
  credentialCount: 0,
  attachedProfileCount: 0,
  ...patch,
})

describe('what the counts say about deleting a group (FR-066)', () => {
  it('reports nothing blocking an empty, unattached group', () => {
    expect(deletionBlockersFromCounts(group())).toEqual([])
  })

  it('names the member-credential condition on its own', () => {
    expect(deletionBlockersFromCounts(group({ credentialCount: 3 }))).toEqual(['credential_member'])
  })

  it('names the attachment condition on its own', () => {
    expect(deletionBlockersFromCounts(group({ attachedProfileCount: 2 }))).toEqual([
      'profile_attachment',
    ])
  })

  it('names both when both hold, because they are fixed in different places', () => {
    expect(
      deletionBlockersFromCounts(group({ credentialCount: 3, attachedProfileCount: 2 })),
    ).toEqual(['credential_member', 'profile_attachment'])
  })

  it('says which condition it is in words, and where the fix is', () => {
    expect(describeDeletionBlocker('credential_member', group({ credentialCount: 4 }))).toContain(
      'move them to another group',
    )
    expect(
      describeDeletionBlocker('profile_attachment', group({ attachedProfileCount: 1 })),
    ).toContain('detach it there first')
  })

  it('agrees with itself about one and many', () => {
    expect(describeDeletionBlocker('credential_member', group({ credentialCount: 1 }))).toContain(
      '1 agent credential;',
    )
    expect(describeDeletionBlocker('credential_member', group({ credentialCount: 2 }))).toContain(
      '2 agent credentials',
    )
  })
})

describe('shaping a group for the card', () => {
  it('reads the state as one word the chip can carry', () => {
    expect(toCredentialGroupReadouts(group()).state).toBe('enabled')
    expect(toCredentialGroupReadouts(group({ enabled: false })).state).toBe('disabled')
  })

  it('reports an archived group as deleted rather than hiding it', () => {
    const readouts = toCredentialGroupReadouts(
      group({ archivedAt: new Date('2026-03-01T00:00:00.000Z'), enabled: false }),
    )

    expect(readouts.state).toBe('deleted')
    expect(readouts.archived).toBe(true)
  })

  it('renders a missing description as a dash rather than as an empty cell', () => {
    expect(toCredentialGroupReadouts(group({ description: null })).description).toBe(ABSENT)
  })

  it('renders the timestamp as a fixed-width UTC readout', () => {
    expect(toCredentialGroupReadouts(group()).created).toBe('2026-02-01 09:30')
  })

  it('carries the FR-066 conditions as sentences, so the card states them ahead of the attempt', () => {
    const readouts = toCredentialGroupReadouts(
      group({ credentialCount: 4, attachedProfileCount: 2 }),
    )

    expect(readouts.blockers).toEqual(['credential_member', 'profile_attachment'])
    expect(readouts.blockerDetails[0]).toContain('4 agent credentials')
    expect(readouts.blockerDetails[1]).toContain('2 execution profiles')
  })
})
