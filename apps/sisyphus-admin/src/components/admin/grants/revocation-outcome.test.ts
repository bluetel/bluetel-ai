import { describe, expect, it } from 'vitest'

import {
  describeGrantError,
  describeGrantResult,
  describeRevocationCascade,
  describeRevocationResult,
} from './revocation-outcome'

const rejection = (code: string): unknown => ({ message: 'refused', data: { code } })

const revoked = (watchesRemoved: number) => ({
  grant: {
    id: '0199a1f4-0000-7000-8000-000000000060',
    userId: '0199a1f4-0000-7000-8000-000000000061',
    executionProfileId: '0199a1f4-0000-7000-8000-000000000062',
    grantedByUserId: '0199a1f4-0000-7000-8000-000000000063',
    grantedAt: new Date('2026-08-01T10:00:00Z'),
    revokedAt: new Date('2026-08-05T09:00:00Z'),
    revokedByUserId: '0199a1f4-0000-7000-8000-000000000063',
  },
  watchesRemoved,
})

describe('describeRevocationCascade', () => {
  const cascade = describeRevocationCascade('An Engineer')

  it('names the holder rather than describing a row', () => {
    expect(cascade[0]).toContain('An Engineer')
  })

  it('says the cascade removes watches, before the admin confirms', () => {
    expect(cascade.join(' ')).toContain('Watches they hold on this profile')
  })

  it('says which watches survive, which is the half an admin gets wrong', () => {
    expect(cascade.join(' ')).toContain('own or initiated')
  })

  it('says in-flight work is untouched, so revocation is not mistaken for a stop', () => {
    expect(cascade.join(' ')).toContain('already in flight are untouched')
  })

  it('says the grant is stamped rather than deleted', () => {
    expect(cascade.join(' ')).toContain('not deleted')
  })

  it('says access is checked per request rather than at session expiry', () => {
    expect(cascade.join(' ')).toContain('next request')
  })

  it('claims no count, because nothing can know it before the transaction runs', () => {
    expect(cascade.join(' ')).not.toMatch(/\b\d+ watches will\b/)
  })
})

describe('describeRevocationResult', () => {
  it('reports the count the server returned', () => {
    const notice = describeRevocationResult(revoked(3))

    expect(notice.readout).toBe('watches removed 3')
    expect(notice.detail).toContain('3 watches')
  })

  it('agrees the verb for a single watch', () => {
    expect(describeRevocationResult(revoked(1)).detail).toContain('1 watch the grant was keeping')
  })

  it('reports zero as loudly as three, so the notice is worth reading', () => {
    const notice = describeRevocationResult(revoked(0))

    expect(notice.readout).toBe('watches removed 0')
    expect(notice.detail).toContain('nothing was removed')
  })

  it('says the kept watches were kept', () => {
    expect(describeRevocationResult(revoked(2)).detail).toContain('own or initiated were kept')
  })
})

describe('describeGrantResult', () => {
  it('reports a grant that was written', () => {
    const notice = describeGrantResult({
      grant: revoked(0).grant,
      created: true,
    })

    expect(notice.readout).toBe('granted')
    expect(notice.detail).toContain('next request')
  })

  it('says plainly when the grant already existed rather than claiming a change', () => {
    const notice = describeGrantResult({ grant: revoked(0).grant, created: false })

    expect(notice.readout).toBe('already held')
    expect(notice.detail).toContain('nothing was written')
  })
})

describe('describeGrantError', () => {
  it('renders the out-of-scope answer as not found, never as a permission message', () => {
    const content = describeGrantError(rejection('NOT_FOUND'))

    expect(content.code).toBe('E_GRANT_TARGET_NOT_FOUND')
    expect(content.action.toLowerCase()).not.toContain('permission')
    expect(content.action.toLowerCase()).not.toContain('allowed')
  })

  it('does not distinguish an unknown user from an unknown profile from a missing grant', () => {
    // The router answers all three identically on purpose; the panel must not add the distinction
    // back by rendering three different messages.
    expect(describeGrantError(rejection('NOT_FOUND')).action).toContain(
      'that user, profile or grant',
    )
  })

  it('leaves the other refusals on the shared mapping', () => {
    expect(describeGrantError(rejection('FORBIDDEN')).code).toBe('E_ADMIN_REQUIRED')
    expect(describeGrantError(rejection('BAD_REQUEST')).code).toBe('E_INVALID_INPUT')
  })

  it('still gives a non-tRPC failure a code and an action', () => {
    expect(describeGrantError(new Error('fetch failed')).code).toBe('E_UNEXPECTED')
  })
})
