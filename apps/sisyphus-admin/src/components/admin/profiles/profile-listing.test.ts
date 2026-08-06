import { describe, expect, it } from 'vitest'

import type { ProfileListItem } from './profile-listing'
import {
  ABSENT,
  profileStateReadout,
  profileVersionReadout,
  toProfileReadouts,
} from './profile-listing'

const profile = (overrides: Partial<ProfileListItem> = {}): ProfileListItem =>
  ({
    id: 'profile-1',
    name: 'Payments',
    description: null,
    enabled: true,
    archivedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    versionCount: 7,
    currentVersion: {
      id: 'version-3',
      executionProfileId: 'profile-1',
      version: 3,
      workspaceVersionId: 'workspace-version-9',
      setupBundleVersionId: 'bundle-version-2',
      model: 'claude-opus-5',
      instanceType: 'm7i.large',
      purchaseMode: 'spot',
      turnCap: 40,
      spendCap: '25.0000',
      defaultWorkflowType: 'delegated',
      promptPreamble: null,
      lockedFields: ['model', 'spendCap'],
      createdByUserId: 'user-1',
      createdAt: new Date('2026-02-01T09:30:00Z'),
    },
    ...overrides,
  }) as ProfileListItem

describe('profileStateReadout (FR-128)', () => {
  it('reads an enabled profile as enabled', () => {
    expect(profileStateReadout(profile())).toBe('enabled')
  })

  it('lets archived win, because it is the state that forbids editing', () => {
    expect(profileStateReadout(profile({ archivedAt: new Date() }))).toBe('archived')
  })
})

describe('profileVersionReadout (FR-125, FR-126)', () => {
  it('says which version is pinned and how many exist, so an edit is visible afterwards', () => {
    expect(profileVersionReadout(profile())).toBe('v3 of 7')
  })

  it('says so plainly when nothing has been published', () => {
    expect(profileVersionReadout(profile({ currentVersion: undefined }))).toBe('none published')
  })
})

describe('toProfileReadouts', () => {
  it('leads with the version rather than with the model', () => {
    expect(toProfileReadouts(profile()).version).toBe('v3 of 7')
  })

  it('carries the version id, which is what a run records (FR-126)', () => {
    expect(toProfileReadouts(profile()).currentVersionId).toBe('version-3')
  })

  it('reads a cap the profile does not set as “no cap” rather than as blank', () => {
    const readouts = toProfileReadouts(
      profile({
        currentVersion: { ...profile().currentVersion, turnCap: null, spendCap: null },
      } as Partial<ProfileListItem>),
    )

    expect(readouts.turnCap).toBe('no cap')
    expect(readouts.spendCap).toBe('no cap')
  })

  it('names the locked fields, because they are refused on every run (FR-123)', () => {
    expect(toProfileReadouts(profile()).lockedFields).toBe('model, spendCap')
  })

  it('says “none” rather than leaving the locked readout blank', () => {
    const readouts = toProfileReadouts(
      profile({
        currentVersion: { ...profile().currentVersion, lockedFields: [] },
      } as Partial<ProfileListItem>),
    )

    expect(readouts.lockedFields).toBe('none')
  })

  it('reads an unpublished profile without inventing values for it', () => {
    const readouts = toProfileReadouts(profile({ currentVersion: undefined }))

    expect(readouts.model).toBe(ABSENT)
    expect(readouts.published).toBe(false)
  })
})
