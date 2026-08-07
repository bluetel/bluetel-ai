import { LOCKABLE_PROFILE_FIELDS } from '@bluetel-ai/sisyphus-api/client'
import { describe, expect, it } from 'vitest'

import {
  describeLaunchFieldLocks,
  LOCKABLE_FIELD_CONTROLS,
  lockedFieldCode,
  lockedFieldRefusals,
  lockedLaunchControls,
} from './profile-locks'
import type { LaunchProfileVersion } from './profile-prefill'
import { prefillFromProfile } from './profile-prefill'

const version = (overrides: Partial<LaunchProfileVersion> = {}): LaunchProfileVersion =>
  ({
    id: 'version-1',
    executionProfileId: 'profile-1',
    version: 2,
    workspaceVersionId: '01890a5d-ac96-774b-bcce-b302099a8057',
    setupBundleVersionId: '01890a5d-ac96-774b-bcce-b302099a8058',
    model: 'claude-opus-5',
    instanceType: 'm7i.large',
    purchaseMode: 'spot',
    turnCap: 40,
    spendCap: '25.0000',
    defaultWorkflowType: 'delegated',
    promptPreamble: null,
    lockedFields: [],
    createdByUserId: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }) as LaunchProfileVersion

describe('describeLaunchFieldLocks (FR-122, FR-123)', () => {
  it('describes every lockable field, so no value the run uses goes unmentioned', () => {
    expect(describeLaunchFieldLocks(version()).map((lock) => lock.field)).toEqual([
      ...LOCKABLE_PROFILE_FIELDS,
    ])
  })

  it('carries the profile’s own value for each field', () => {
    const locks = describeLaunchFieldLocks(version())

    expect(locks.find((lock) => lock.field === 'model')?.profileValue).toBe('claude-opus-5')
    expect(locks.find((lock) => lock.field === 'turnCap')?.profileValue).toBe('40')
    expect(locks.find((lock) => lock.field === 'workflowType')?.profileValue).toBe('delegated')
  })

  it('reads a cap the profile does not set as blank rather than as zero', () => {
    const locks = describeLaunchFieldLocks(version({ turnCap: null, spendCap: null }))

    expect(locks.find((lock) => lock.field === 'turnCap')?.profileValue).toBe('')
    expect(locks.find((lock) => lock.field === 'spendCap')?.profileValue).toBe('')
  })

  it('marks exactly the fields the version locks, and nothing else', () => {
    const locks = describeLaunchFieldLocks(version({ lockedFields: ['model', 'spendCap'] }))

    expect(locks.filter((lock) => lock.locked).map((lock) => lock.field)).toEqual([
      'model',
      'spendCap',
    ])
  })

  it('keys each lock to the control it belongs under', () => {
    for (const lock of describeLaunchFieldLocks(version())) {
      expect(lock.control).toBe(LOCKABLE_FIELD_CONTROLS[lock.field])
    }
  })
})

describe('lockedLaunchControls', () => {
  it('answers with the controls a locked profile forbids editing', () => {
    const controls = lockedLaunchControls(version({ lockedFields: ['instanceType'] }))

    expect(controls.has('instanceType')).toBe(true)
    expect(controls.has('model')).toBe(false)
  })
})

describe('lockedFieldRefusals (FR-123)', () => {
  it('refuses nothing when the form still holds the profile’s own values', () => {
    const locked = version({ lockedFields: ['model', 'turnCap'] })

    expect(lockedFieldRefusals(locked, prefillFromProfile(locked))).toEqual({})
  })

  it('refuses a locked field that was changed, rather than dropping the change', () => {
    const locked = version({ lockedFields: ['model'] })
    const values = { ...prefillFromProfile(locked), model: 'claude-sonnet-5' }

    const refusal = lockedFieldRefusals(locked, values).model

    expect(refusal?.code).toBe('E_LAUNCH_LOCKED_MODEL')
    expect(refusal?.action).toContain('fixes model')
  })

  it('names every locked field at once, not one refusal per attempt', () => {
    const locked = version({ lockedFields: ['model', 'spendCap'] })
    const values = {
      ...prefillFromProfile(locked),
      model: 'claude-sonnet-5',
      spendCap: '99.0000',
    }

    expect(Object.keys(lockedFieldRefusals(locked, values)).sort()).toEqual(['model', 'spendCap'])
  })

  it('says nothing about a field the profile leaves open, however far it was changed', () => {
    const open = version({ lockedFields: [] })
    const values = { ...prefillFromProfile(open), instanceType: 'm7i.24xlarge' }

    expect(lockedFieldRefusals(open, values)).toEqual({})
  })
})

describe('lockedFieldCode', () => {
  it('produces a searchable, quotable code per field', () => {
    expect(lockedFieldCode('spendCap')).toBe('E_LAUNCH_LOCKED_SPEND_CAP')
    expect(lockedFieldCode('model')).toBe('E_LAUNCH_LOCKED_MODEL')
  })
})
