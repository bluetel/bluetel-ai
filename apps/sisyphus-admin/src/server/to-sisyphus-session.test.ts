import { describe, expect, it } from 'vitest'

import type { AuthSessionLike } from './to-sisyphus-session'
import { toSisyphusSession } from './to-sisyphus-session'

const EXPIRES = '2026-08-06T09:00:00.000Z'

const session = (user: AuthSessionLike['user']): AuthSessionLike => ({ user, expires: EXPIRES })

const engineer = {
  id: '0199a1f4-0000-7000-8000-000000000001',
  email: 'engineer@bluetel.co.uk',
  displayName: 'An Engineer',
  role: 'engineer',
  isActive: true,
}

describe('toSisyphusSession', () => {
  it('projects a complete session onto the contract shape', () => {
    expect(toSisyphusSession(session(engineer))).toStrictEqual({
      user: {
        id: engineer.id,
        email: engineer.email,
        displayName: engineer.displayName,
        role: 'engineer',
        isActive: true,
      },
      expiresAt: new Date(EXPIRES),
    })
  })

  it('carries the admin role through, because that is what adminProcedure reads', () => {
    expect(toSisyphusSession(session({ ...engineer, role: 'admin' }))?.user.role).toBe('admin')
  })

  it('reads null and a session with no user as unauthenticated', () => {
    expect(toSisyphusSession(null)).toBeNull()
    expect(toSisyphusSession({ expires: EXPIRES })).toBeNull()
  })

  it.each([
    ['id', { ...engineer, id: undefined }],
    ['email', { ...engineer, email: undefined }],
    ['displayName', { ...engineer, displayName: null }],
    ['role', { ...engineer, role: undefined }],
    ['isActive', { ...engineer, isActive: undefined }],
  ])('treats a session missing %s as absent rather than as a typed one', (_field, user) => {
    expect(toSisyphusSession(session(user))).toBeNull()
  })

  it('refuses a role outside the vocabulary rather than passing it to the middleware', () => {
    expect(toSisyphusSession(session({ ...engineer, role: 'superuser' }))).toBeNull()
  })

  it('keeps a deactivated user, so authedProcedure refuses and records rather than seeing nobody', () => {
    const resolved = toSisyphusSession(session({ ...engineer, isActive: false }))
    expect(resolved?.user.isActive).toBe(false)
  })

  it('reports an unreadable expiry as already over rather than as an invalid date', () => {
    const resolved = toSisyphusSession({ user: engineer, expires: 'not a date' })
    expect(resolved?.expiresAt.getTime()).toBe(0)
    expect(Number.isNaN(resolved?.expiresAt.getTime())).toBe(false)
  })

  it('does the same when the expiry is missing entirely', () => {
    expect(toSisyphusSession({ user: engineer })?.expiresAt.getTime()).toBe(0)
  })
})
