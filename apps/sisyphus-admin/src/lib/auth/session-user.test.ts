import { describe, expect, it } from 'vitest'

import type { SessionUserRow, SisyphusSessionUser } from './session-user'
import { isActiveSessionUser, isAdminSessionUser, toSessionUser } from './session-user'

const row = (overrides: Partial<SessionUserRow> = {}): SessionUserRow => ({
  id: '019218a7-0000-7000-8000-000000000001',
  email: 'alice@bluetel.co.uk',
  displayName: 'Alice Example',
  name: 'Alice from Google',
  role: 'engineer',
  isActive: true,
  ...overrides,
})

const sessionUser = (overrides: Partial<SisyphusSessionUser> = {}): SisyphusSessionUser => ({
  ...toSessionUser(row()),
  ...overrides,
})

describe('toSessionUser', () => {
  it('carries role and activation onto the session, because both are re-read per request', () => {
    expect(toSessionUser(row({ role: 'admin', isActive: false }))).toMatchObject({
      role: 'admin',
      isActive: false,
    })
  })

  it("prefers the platform's display_name over the IdP-supplied name", () => {
    expect(toSessionUser(row()).displayName).toBe('Alice Example')
  })

  it('falls back to the IdP name, then to the address, rather than rendering nothing', () => {
    expect(toSessionUser(row({ displayName: '' })).displayName).toBe('Alice from Google')
    expect(toSessionUser(row({ displayName: '   ', name: null })).displayName).toBe(
      'alice@bluetel.co.uk',
    )
  })
})

describe('isActiveSessionUser', () => {
  it('honours an active user', () => {
    expect(isActiveSessionUser(sessionUser())).toBe(true)
  })

  it('turns away a deactivated user who still holds a valid session (FR-175)', () => {
    expect(isActiveSessionUser(sessionUser({ isActive: false }))).toBe(false)
  })

  it('turns away an absent session', () => {
    expect(isActiveSessionUser(undefined)).toBe(false)
  })
})

describe('isAdminSessionUser', () => {
  it('requires the admin role', () => {
    expect(isAdminSessionUser(sessionUser({ role: 'admin' }))).toBe(true)
    expect(isAdminSessionUser(sessionUser({ role: 'engineer' }))).toBe(false)
  })

  it('refuses a deactivated admin — activation is checked before the role', () => {
    expect(isAdminSessionUser(sessionUser({ role: 'admin', isActive: false }))).toBe(false)
  })
})
