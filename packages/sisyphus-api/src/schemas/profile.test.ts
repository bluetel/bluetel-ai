import { describe, expect, it } from 'vitest'

import {
  cloneProfileInput,
  createProfileInput,
  listProfilesInput,
  LOCKABLE_PROFILE_FIELDS,
  profileVersionInput,
  setProfileEnabledInput,
  updateProfileInput,
} from './profile'

const ID = '01890a5d-ac96-774b-bcce-b302099a8057'

const version = {
  workspaceVersionId: ID,
  setupBundleVersionId: ID,
  model: 'claude-opus-5',
  instanceType: 'm7i.large',
  purchaseMode: 'spot',
  defaultWorkflowType: 'delegated',
}

describe('profileVersionInput', () => {
  it('pins the bundle **version** and workspace **version**, not their parents', () => {
    // A profile that validated against one bundle version must not be silently re-pointed at
    // another (data-model.md → execution_profile_versions).
    const keys = Object.keys(profileVersionInput.shape)

    expect(keys).toContain('setupBundleVersionId')
    expect(keys).toContain('workspaceVersionId')
    expect(keys).not.toContain('setupBundleId')
    expect(keys).not.toContain('workspaceId')
  })

  it('accepts a version with no caps — a cap is optional, not defaulted to zero', () => {
    expect(profileVersionInput.parse(version).lockedFields).toStrictEqual([])
  })

  it('rejects a model outside the allowlist (FR-009)', () => {
    expect(profileVersionInput.safeParse({ ...version, model: 'gpt-9' }).success).toBe(false)
  })
})

describe('LOCKABLE_PROFILE_FIELDS', () => {
  it('is a closed set, so a typo cannot silently lock nothing (FR-123)', () => {
    expect(
      profileVersionInput.safeParse({ ...version, lockedFields: ['model', 'spendCap'] }).success,
    ).toBe(true)
    expect(
      profileVersionInput.safeParse({ ...version, lockedFields: ['not-a-model'] }).success,
    ).toBe(false)
  })

  it('covers every field a launch may override', () => {
    expect([...LOCKABLE_PROFILE_FIELDS].sort()).toStrictEqual([
      'instanceType',
      'model',
      'purchaseMode',
      'spendCap',
      'turnCap',
      'workflowType',
    ])
  })
})

describe('createProfileInput', () => {
  it('needs a name and a complete version', () => {
    expect(createProfileInput.parse({ ...version, name: 'alpha' })).toMatchObject({
      name: 'alpha',
      model: 'claude-opus-5',
    })
    expect(createProfileInput.safeParse({ name: 'alpha' }).success).toBe(false)
  })
})

describe('updateProfileInput', () => {
  it('submits a complete version, because an edit creates one (FR-125)', () => {
    expect(updateProfileInput.safeParse({ executionProfileId: ID, name: 'renamed' }).success).toBe(
      false,
    )
    expect(updateProfileInput.safeParse({ ...version, executionProfileId: ID }).success).toBe(true)
  })
})

describe('cloneProfileInput, setProfileEnabledInput and listProfilesInput', () => {
  it('take exactly what they need (FR-124, FR-127)', () => {
    expect(cloneProfileInput.parse({ executionProfileId: ID, name: 'copy' })).toStrictEqual({
      executionProfileId: ID,
      name: 'copy',
    })
    expect(setProfileEnabledInput.parse({ executionProfileId: ID, enabled: true })).toStrictEqual({
      executionProfileId: ID,
      enabled: true,
    })
    expect(listProfilesInput.parse({}).limit).toBe(50)
  })
})
