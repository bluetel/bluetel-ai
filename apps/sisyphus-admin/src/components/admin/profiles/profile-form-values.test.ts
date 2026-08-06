import { describe, expect, it } from 'vitest'

import type { ProfileDraft } from './profile-form-values'
import {
  draftFromProfileVersion,
  EMPTY_PROFILE,
  profileFieldCode,
  toCreateProfileInput,
  toUpdateProfileInput,
  withLockedField,
} from './profile-form-values'
import type { ProfileVersionItem } from './profile-listing'

const WORKSPACE_VERSION_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const BUNDLE_VERSION_ID = '01890a5d-ac96-774b-bcce-b302099a8058'
const PROFILE_ID = '01890a5d-ac96-774b-bcce-b302099a8050'

const filled = (overrides: Partial<ProfileDraft> = {}): ProfileDraft => ({
  ...EMPTY_PROFILE,
  name: 'Payments',
  workspaceVersionId: WORKSPACE_VERSION_ID,
  setupBundleVersionId: BUNDLE_VERSION_ID,
  model: 'claude-opus-5',
  instanceType: 'm7i.large',
  purchaseMode: 'spot',
  defaultWorkflowType: 'delegated',
  ...overrides,
})

describe('EMPTY_PROFILE', () => {
  it('pre-selects nothing, because a default quietly accepted is a default nobody chose', () => {
    expect(EMPTY_PROFILE.model).toBe('')
    expect(EMPTY_PROFILE.purchaseMode).toBe('')
    expect(EMPTY_PROFILE.lockedFields).toEqual([])
  })
})

describe('withLockedField (FR-123)', () => {
  it('adds a lock, keeping the platform’s own field order', () => {
    expect(withLockedField(['spendCap'], 'model', true)).toEqual(['model', 'spendCap'])
  })

  it('removes a lock', () => {
    expect(withLockedField(['model', 'spendCap'], 'model', false)).toEqual(['spendCap'])
  })
})

describe('draftFromProfileVersion (FR-125)', () => {
  it('starts an edit from the version a launch would pin, not from the profile row', () => {
    const version = {
      workspaceVersionId: WORKSPACE_VERSION_ID,
      setupBundleVersionId: BUNDLE_VERSION_ID,
      model: 'claude-opus-5',
      instanceType: 'm7i.large',
      purchaseMode: 'spot',
      turnCap: 40,
      spendCap: '25.0000',
      defaultWorkflowType: 'delegated',
      promptPreamble: 'You are working on payments.',
      lockedFields: ['model'],
    } as unknown as ProfileVersionItem

    expect(draftFromProfileVersion(version, { name: 'Payments', description: null })).toEqual({
      name: 'Payments',
      description: '',
      workspaceVersionId: WORKSPACE_VERSION_ID,
      setupBundleVersionId: BUNDLE_VERSION_ID,
      model: 'claude-opus-5',
      instanceType: 'm7i.large',
      purchaseMode: 'spot',
      turnCap: '40',
      spendCap: '25.0000',
      defaultWorkflowType: 'delegated',
      promptPreamble: 'You are working on payments.',
      lockedFields: ['model'],
    })
  })

  it('reads a cap the version does not set as blank rather than as zero', () => {
    const version = {
      workspaceVersionId: WORKSPACE_VERSION_ID,
      setupBundleVersionId: BUNDLE_VERSION_ID,
      model: 'claude-opus-5',
      instanceType: 'm7i.large',
      purchaseMode: 'spot',
      turnCap: null,
      spendCap: null,
      defaultWorkflowType: 'delegated',
      promptPreamble: null,
      lockedFields: [],
    } as unknown as ProfileVersionItem

    const draft = draftFromProfileVersion(version, { name: 'Payments', description: null })

    expect(draft.turnCap).toBe('')
    expect(draft.spendCap).toBe('')
  })
})

describe('toCreateProfileInput', () => {
  it('publishes a profile with no caps when both are left blank', () => {
    const submission = toCreateProfileInput(filled())

    expect(submission.ok && submission.input.turnCap).toBeNull()
    expect(submission.ok && submission.input.spendCap).toBeNull()
  })

  it('carries the locked fields through as the closed set the platform knows (FR-123)', () => {
    const submission = toCreateProfileInput(filled({ lockedFields: ['model', 'spendCap'] }))

    expect(submission.ok && submission.input.lockedFields).toEqual(['model', 'spendCap'])
  })

  it('refuses a turn cap that is not a number rather than publishing an uncapped profile', () => {
    const submission = toCreateProfileInput(filled({ turnCap: '4o' }))

    expect(submission.ok).toBe(false)
    expect(!submission.ok && submission.errors.turnCap?.code).toBe('E_PROFILE_TURN_CAP')
  })

  it('refuses a missing workspace version, pointing at its own control', () => {
    const submission = toCreateProfileInput(filled({ workspaceVersionId: '' }))

    expect(submission.ok).toBe(false)
    expect(!submission.ok && submission.errors.workspaceVersionId).toBeDefined()
  })

  it('refuses a missing name', () => {
    const submission = toCreateProfileInput(filled({ name: '  ' }))

    expect(submission.ok).toBe(false)
    expect(!submission.ok && submission.errors.name?.code).toBe('E_PROFILE_NAME')
  })

  it('sends a blank preamble as null, so the version says “no preamble” rather than “empty”', () => {
    const submission = toCreateProfileInput(filled())

    expect(submission.ok && submission.input.promptPreamble).toBeNull()
  })
})

describe('toUpdateProfileInput (FR-125)', () => {
  it('is the create submission addressed to an existing profile, and nothing else', () => {
    const created = toCreateProfileInput(filled())
    const updated = toUpdateProfileInput(PROFILE_ID, filled())

    if (!created.ok || !updated.ok) throw new Error('both submissions should have been accepted')

    expect(updated.input.executionProfileId).toBe(PROFILE_ID)
    expect(updated.input.model).toBe(created.input.model)
    expect(updated.input.lockedFields).toEqual(created.input.lockedFields)
  })

  it('refuses exactly what the create submission refuses', () => {
    expect(toUpdateProfileInput(PROFILE_ID, filled({ model: '' })).ok).toBe(false)
  })
})

describe('profileFieldCode', () => {
  it('produces a searchable, quotable code per field', () => {
    expect(profileFieldCode('spendCap')).toBe('E_PROFILE_SPEND_CAP')
    expect(profileFieldCode('setupBundleVersionId')).toBe('E_PROFILE_SETUP_BUNDLE_VERSION_ID')
  })
})
