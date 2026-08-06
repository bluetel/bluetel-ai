import { describe, expect, it } from 'vitest'

import * as grants from './index'

describe('the grant-management barrel', () => {
  it('publishes the screen and the shaping its tests reach for', () => {
    expect(Object.keys(grants).sort()).toStrictEqual([
      'GrantRow',
      'IssueGrantForm',
      'ProfileAccessPanel',
      'RevokeConfirmation',
      'describeGrantError',
      'describeGrantResult',
      'describeRevocationCascade',
      'describeRevocationResult',
      'isLiveGrant',
      'liveGrantHolderIds',
      'toGrantReadouts',
    ])
  })

  it('exposes no second class-merge helper and no local button', () => {
    expect(Object.keys(grants)).not.toContain('cn')
    expect(Object.keys(grants)).not.toContain('Button')
  })
})
