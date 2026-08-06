import { describe, expect, it } from 'vitest'

import * as users from './index'

describe('the user-management barrel', () => {
  it('publishes the screen and the shaping its tests reach for', () => {
    expect(Object.keys(users).sort()).toStrictEqual([
      'LAST_ACTIVE_ADMIN_ERROR',
      'NO_REASON',
      'RoleChangeHistory',
      'SYSTEM_ACTOR',
      'UserActionForm',
      'UserCard',
      'UsersPanel',
      'availableUserActions',
      'describeUserChange',
      'describeUserChangeError',
      'hasWorkInFlight',
      'toRoleChangeReadouts',
      'toUserReadouts',
      'userAction',
    ])
  })

  it('exposes no second class-merge helper and no local button', () => {
    expect(Object.keys(users)).not.toContain('cn')
    expect(Object.keys(users)).not.toContain('Button')
  })
})
