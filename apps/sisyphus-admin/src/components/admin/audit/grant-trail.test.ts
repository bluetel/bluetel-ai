import { describe, expect, it } from 'vitest'

import type { UserGrant } from './grant-trail'
import { NO_ACTOR, toGrantTrailReadouts } from './grant-trail'

/**
 * The one mistake this shaping exists to prevent is a revoked grant rendered as though it were
 * live. A revocation is a write of `revoked_at` rather than a delete (FR-184), so the row's state
 * has to be **derived** from that column and never assumed from the row being in the list — a
 * distinction that is invisible in the markup and obvious in a table of inputs.
 */

const grant = (over: Partial<UserGrant> = {}): UserGrant => ({
  id: '0199a1f4-0000-7000-8000-0000000000ab',
  executionProfileId: '0199a1f4-0000-7000-8000-0000000000cd',
  profileName: 'API maintenance',
  grantedAt: new Date('2026-08-01T09:00:00.000Z'),
  grantedByUserId: '0199a1f4-0000-7000-8000-0000000000ef',
  revokedAt: null,
  revokedByUserId: null,
  ...over,
})

describe('one row of the access history', () => {
  it('reads a live grant as live, with no revocation timestamp', () => {
    const readouts = toGrantTrailReadouts(grant())

    expect(readouts.state).toBe('live')
    expect(readouts.profile).toBe('API maintenance')
    // `never` is the readout an absent timestamp gets everywhere in this console.
    expect(readouts.revokedAt).toBe('never')
    expect(readouts.revokedBy).toBe(NO_ACTOR)
  })

  it('reads a revoked grant as revoked, and still shows when it was granted', () => {
    const readouts = toGrantTrailReadouts(
      grant({
        revokedAt: new Date('2026-08-05T09:00:00.000Z'),
        revokedByUserId: '0199a1f4-0000-7000-8000-00000000ffff',
      }),
    )

    expect(readouts.state).toBe('revoked')
    expect(readouts.grantedAt).not.toBe('never')
    expect(readouts.revokedAt).not.toBe('never')
    // SC-053: every revocation attributable to an acting admin with a timestamp.
    expect(readouts.revokedBy).toBe('0199a1f4-0000-7000-8000-00000000ffff')
  })

  it('attributes the grant to the admin who issued it (SC-053)', () => {
    expect(toGrantTrailReadouts(grant()).grantedBy).toBe('0199a1f4-0000-7000-8000-0000000000ef')
  })
})
