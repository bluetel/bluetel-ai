import { describe, expect, it } from 'vitest'

import { DEFAULT_USER_ROLE, isUserRole, USER_ROLES } from './user-role'

describe('USER_ROLES', () => {
  it('is exactly engineer and admin (FR-166)', () => {
    expect([...USER_ROLES]).toStrictEqual(['engineer', 'admin'])
  })

  it('defaults a newly created user to the unprivileged role (FR-170)', () => {
    expect(DEFAULT_USER_ROLE).toBe('engineer')
    expect(USER_ROLES).toContain(DEFAULT_USER_ROLE)
  })

  it('guards membership', () => {
    expect(isUserRole('admin')).toBe(true)
    expect(isUserRole('superuser')).toBe(false)
  })
})
