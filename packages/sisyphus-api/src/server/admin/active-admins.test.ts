import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'

import type { LockedUserState } from './active-admins'
import {
  assertActiveAdminRemains,
  isActiveAdmin,
  lastActiveAdminError,
  userNotFoundError,
  wouldLeaveZeroActiveAdmins,
} from './active-admins'

/**
 * The **decision** is tested here; the **lock** is tested against a live database in
 * `./users.test.ts`, where a single harness races two real transactions and proves one of them
 * blocks and loses.
 *
 * The split is deliberate rather than convenient. Nothing a mock can express distinguishes
 * `select … for update` from a plain count — both return a number — so a mocked test of
 * {@link lockUsersForRoleChange} would pass just as happily against the broken implementation. It
 * would be worse than no test, because it would look like coverage.
 */

const activeAdmin: LockedUserState = { id: 'a', role: 'admin', isActive: true }
const inactiveAdmin: LockedUserState = { id: 'b', role: 'admin', isActive: false }
const engineer: LockedUserState = { id: 'c', role: 'engineer', isActive: true }

describe('isActiveAdmin', () => {
  it('counts only a user who is both an admin and active', () => {
    expect(isActiveAdmin(activeAdmin)).toBe(true)
    expect(isActiveAdmin(inactiveAdmin)).toBe(false)
    expect(isActiveAdmin(engineer)).toBe(false)
  })
})

describe('wouldLeaveZeroActiveAdmins', () => {
  it('refuses demoting the last active admin (FR-173)', () => {
    expect(
      wouldLeaveZeroActiveAdmins({
        activeAdminCount: 1,
        before: activeAdmin,
        after: { role: 'engineer', isActive: true },
      }),
    ).toBe(true)
  })

  it('refuses the last active admin deactivating themselves (FR-173)', () => {
    // Self-demotion needs no special case: the actor is simply the last one counted.
    expect(
      wouldLeaveZeroActiveAdmins({
        activeAdminCount: 1,
        before: activeAdmin,
        after: { role: 'admin', isActive: false },
      }),
    ).toBe(true)
  })

  it('permits the same change while another admin remains', () => {
    expect(
      wouldLeaveZeroActiveAdmins({
        activeAdminCount: 2,
        before: activeAdmin,
        after: { role: 'engineer', isActive: true },
      }),
    ).toBe(false)
  })

  it('permits changing someone who was not an active admin to begin with', () => {
    expect(
      wouldLeaveZeroActiveAdmins({
        activeAdminCount: 1,
        before: engineer,
        after: { role: 'engineer', isActive: false },
      }),
    ).toBe(false)
    expect(
      wouldLeaveZeroActiveAdmins({
        activeAdminCount: 1,
        before: inactiveAdmin,
        after: { role: 'engineer', isActive: false },
      }),
    ).toBe(false)
  })

  it('permits a change that leaves the subject an active admin', () => {
    // Editing an admin who stays an admin never threatens the invariant, whatever the count.
    expect(
      wouldLeaveZeroActiveAdmins({
        activeAdminCount: 1,
        before: activeAdmin,
        after: { role: 'admin', isActive: true },
      }),
    ).toBe(false)
  })

  it('permits reactivating the only admin, which restores rather than removes one', () => {
    // The recovery path from zero active admins must not itself be refused for leaving zero.
    expect(
      wouldLeaveZeroActiveAdmins({
        activeAdminCount: 0,
        before: inactiveAdmin,
        after: { role: 'admin', isActive: true },
      }),
    ).toBe(false)
  })
})

describe('assertActiveAdminRemains', () => {
  it('throws the refusal when the invariant would break', () => {
    expect(() =>
      assertActiveAdminRemains({
        activeAdminCount: 1,
        before: activeAdmin,
        after: { role: 'engineer', isActive: true },
      }),
    ).toThrow(TRPCError)
  })

  it('returns quietly otherwise', () => {
    expect(() =>
      assertActiveAdminRemains({
        activeAdminCount: 3,
        before: activeAdmin,
        after: { role: 'engineer', isActive: true },
      }),
    ).not.toThrow()
  })
})

describe('the error codes', () => {
  it('refuses the last-admin change as a precondition, not as a permission problem', () => {
    // The caller does hold the admin role; the platform's state is what makes this one
    // impossible, so `FORBIDDEN` would tell them to go and get a permission they already have.
    expect(lastActiveAdminError().code).toBe('PRECONDITION_FAILED')
  })

  it('reports an unknown user as absent and names nothing (FR-190)', () => {
    const error = userNotFoundError()
    expect(error.code).toBe('NOT_FOUND')
    expect(error.message).toBe('User not found.')
  })
})
