import { describe, expect, it } from 'vitest'

import {
  grantProfileAccessInput,
  listGrantsForProfileInput,
  listGrantsForUserInput,
  listRoleChangesInput,
  listUsersInput,
  revokeProfileAccessInput,
  setUserActiveInput,
  setUserRoleInput,
} from './access'

const ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const OTHER_ID = '01890a5d-ac96-774b-bcce-b302099a8058'

describe('setUserRoleInput', () => {
  it('accepts only the two roles (FR-170)', () => {
    expect(setUserRoleInput.safeParse({ userId: ID, role: 'admin' }).success).toBe(true)
    expect(setUserRoleInput.safeParse({ userId: ID, role: 'engineer' }).success).toBe(true)
    expect(setUserRoleInput.safeParse({ userId: ID, role: 'superuser' }).success).toBe(false)
  })
})

describe('setUserActiveInput', () => {
  it('deactivates rather than deletes — history references the row (FR-176)', () => {
    const keys = Object.keys(setUserActiveInput.shape)

    expect(keys).toContain('isActive')
    expect(keys).not.toContain('delete')
  })

  it('requires the new state rather than toggling, so a double submit is idempotent', () => {
    expect(setUserActiveInput.safeParse({ userId: ID }).success).toBe(false)
    expect(setUserActiveInput.parse({ userId: ID, isActive: false })).toMatchObject({
      isActive: false,
    })
  })
})

describe('grantProfileAccessInput and revokeProfileAccessInput', () => {
  it('name the same pair, because revoking is a write on the grant, not a delete (FR-184)', () => {
    const value = { userId: ID, executionProfileId: OTHER_ID }

    expect(grantProfileAccessInput.parse(value)).toStrictEqual(value)
    expect(revokeProfileAccessInput.parse(value)).toStrictEqual(value)
  })

  it('rejects a grant naming no profile', () => {
    expect(grantProfileAccessInput.safeParse({ userId: ID }).success).toBe(false)
  })
})

describe('the grant listings', () => {
  it('hide revoked grants unless asked, but can show them for the audit trail (FR-184)', () => {
    expect(listGrantsForProfileInput.parse({ executionProfileId: ID }).includeRevoked).toBe(false)
    expect(listGrantsForUserInput.parse({ userId: ID, includeRevoked: true }).includeRevoked).toBe(
      true,
    )
  })
})

describe('listUsersInput and listRoleChangesInput', () => {
  it('are paginated like every other listing', () => {
    expect(listUsersInput.parse({}).limit).toBe(50)
    expect(listRoleChangesInput.parse({}).limit).toBe(50)
  })

  it('filter role changes by subject, which is how "who made this person an admin" is answered', () => {
    expect(listRoleChangesInput.parse({ subjectUserId: ID }).subjectUserId).toBe(ID)
  })
})
