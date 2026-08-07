import { describe, expect, it } from 'vitest'

import type { ProfileGrant } from './grant-listing'
import { isLiveGrant, liveGrantHolderIds, toGrantReadouts } from './grant-listing'

const grant = (overrides: Partial<ProfileGrant> = {}): ProfileGrant => ({
  id: '0199a1f4-0000-7000-8000-000000000050',
  userId: '0199a1f4-0000-7000-8000-000000000051',
  email: 'engineer@bluetel.co.uk',
  displayName: 'An Engineer',
  grantedAt: new Date('2026-08-01T10:00:00Z'),
  grantedByUserId: '0199a1f4-0000-7000-8000-000000000052',
  revokedAt: null,
  revokedByUserId: null,
  ...overrides,
})

describe('isLiveGrant', () => {
  it('is true while revoked_at is null', () => {
    expect(isLiveGrant(grant())).toBe(true)
  })

  it('is false once revoked, even though the row is still in the list', () => {
    expect(isLiveGrant(grant({ revokedAt: new Date('2026-08-05T09:00:00Z') }))).toBe(false)
  })
})

describe('toGrantReadouts', () => {
  it('names the holder and when access was issued', () => {
    const readouts = toGrantReadouts(grant())

    expect(readouts.displayName).toBe('An Engineer')
    expect(readouts.email).toBe('engineer@bluetel.co.uk')
    expect(readouts.grantedAt).toBe('2026-08-01 10:00')
  })

  it('derives the state from revoked_at rather than from the row being present', () => {
    expect(toGrantReadouts(grant()).state).toBe('live')
    expect(toGrantReadouts(grant({ revokedAt: new Date('2026-08-05T09:00:00Z') })).state).toBe(
      'revoked',
    )
  })

  it('renders a live grant’s revocation time as never rather than as an empty cell', () => {
    expect(toGrantReadouts(grant()).revokedAt).toBe('never')
  })

  it('renders the revocation time once there is one', () => {
    expect(toGrantReadouts(grant({ revokedAt: new Date('2026-08-05T09:14:00Z') })).revokedAt).toBe(
      '2026-08-05 09:14',
    )
  })
})

describe('liveGrantHolderIds', () => {
  it('collects the users who hold access now', () => {
    const holders = liveGrantHolderIds([grant(), grant({ id: 'b', userId: 'second' })])

    expect(holders.has('0199a1f4-0000-7000-8000-000000000051')).toBe(true)
    expect(holders.has('second')).toBe(true)
  })

  it('leaves out a user whose grant was revoked, so they can be granted again', () => {
    const holders = liveGrantHolderIds([grant({ revokedAt: new Date('2026-08-05T09:00:00Z') })])

    expect(holders.size).toBe(0)
  })

  it('counts a user once even when their access history has several rows', () => {
    const holders = liveGrantHolderIds([
      grant({ id: 'old', revokedAt: new Date('2026-07-01T09:00:00Z') }),
      grant({ id: 'new' }),
    ])

    expect(holders.size).toBe(1)
  })
})
