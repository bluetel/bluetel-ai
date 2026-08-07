import type { RouterOutputs } from '@bluetel-ai/sisyphus-api/client'
import { describe, expect, it } from 'vitest'

import { toOwnerOptions, toProfileOptions } from './integration-options'

type ProfileListingOutput = RouterOutputs['admin']['profiles']['list']['items'][number]
type UserListingOutput = RouterOutputs['admin']['users']['list']['items'][number]

const VERSION = {
  version: 3,
} as NonNullable<ProfileListingOutput['currentVersion']>

const profile = (overrides: Partial<ProfileListingOutput> = {}): ProfileListingOutput =>
  ({
    id: 'profile-1',
    name: 'API delivery',
    description: null,
    enabled: true,
    archivedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    currentVersion: VERSION,
    versionCount: 3,
    ...overrides,
  }) as ProfileListingOutput

const user = (overrides: Partial<UserListingOutput> = {}): UserListingOutput =>
  ({
    id: 'user-1',
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    role: 'engineer',
    isActive: true,
    slackUserId: null,
    lastSignInAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ownedWorkflowCount: 0,
    workflowsAwaitingReassignment: 0,
    ...overrides,
  }) as UserListingOutput

describe('toProfileOptions (FR-130)', () => {
  it('offers a profile a run could start from', () => {
    expect(toProfileOptions([profile()])).toStrictEqual([
      { value: 'profile-1', label: 'API delivery — v3' },
    ])
  })

  it('names the pinned version, because that is what distinguishes two similar profiles', () => {
    const options = toProfileOptions([
      profile({ id: 'a', name: 'Delivery', currentVersion: { version: 1 } as never }),
      profile({ id: 'b', name: 'Delivery', currentVersion: { version: 9 } as never }),
    ])

    expect(options.map((option) => option.label)).toStrictEqual(['Delivery — v1', 'Delivery — v9'])
  })

  it('excludes an archived profile — a mapping onto one resolves and then fails', () => {
    expect(
      toProfileOptions([profile({ archivedAt: new Date('2026-02-01T00:00:00.000Z') })]),
    ).toStrictEqual([])
  })

  it('excludes a disabled profile for the same reason', () => {
    expect(toProfileOptions([profile({ enabled: false })])).toStrictEqual([])
  })

  it('excludes a profile with no published version, which nothing can be launched from', () => {
    expect(toProfileOptions([profile({ currentVersion: undefined })])).toStrictEqual([])
  })

  it('is empty rather than throwing when nothing is loaded yet', () => {
    expect(toProfileOptions([])).toStrictEqual([])
  })
})

describe('toOwnerOptions (FR-133)', () => {
  it('labels a person by their display name', () => {
    expect(toOwnerOptions([user()])).toStrictEqual([{ value: 'user-1', label: 'Ada Lovelace' }])
  })

  it('falls back to the email, which is the identity the platform authenticated', () => {
    expect(toOwnerOptions([user({ displayName: '' })])).toStrictEqual([
      { value: 'user-1', label: 'ada@example.com' },
    ])
    expect(toOwnerOptions([user({ displayName: '   ' })])).toStrictEqual([
      { value: 'user-1', label: 'ada@example.com' },
    ])
  })

  it('excludes a deactivated user — a default owner must be answerable for a run', () => {
    expect(toOwnerOptions([user({ isActive: false })])).toStrictEqual([])
  })

  it('is empty rather than throwing when nothing is loaded yet', () => {
    expect(toOwnerOptions([])).toStrictEqual([])
  })
})
