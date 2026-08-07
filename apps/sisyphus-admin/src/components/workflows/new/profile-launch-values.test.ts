import { describe, expect, it } from 'vitest'

import { EMPTY_LAUNCH_FORM } from './launch-form-values'
import {
  profileFieldCode,
  profileFieldError,
  profileFieldForIssuePath,
  toStartWorkflowInput,
} from './profile-launch-values'
import type { LaunchProfile, LaunchProfileVersion } from './profile-prefill'
import { prefillFromProfile } from './profile-prefill'

const PROFILE_ID = '01890a5d-ac96-774b-bcce-b302099a8050'
const SESSION_ID = '01890a5d-ac96-774b-bcce-b302099a8059'

const version = (overrides: Partial<LaunchProfileVersion> = {}): LaunchProfileVersion =>
  ({
    id: 'version-1',
    executionProfileId: PROFILE_ID,
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

const profile = (overrides: Partial<LaunchProfileVersion> = {}): LaunchProfile =>
  ({
    id: PROFILE_ID,
    name: 'Payments',
    description: null,
    enabled: true,
    archivedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    currentVersion: version(overrides),
    versionCount: 2,
  }) as LaunchProfile

const filled = (chosen = profile(), prompt = 'fix the failing test') => ({
  ...prefillFromProfile(chosen.currentVersion ?? version(), { ...EMPTY_LAUNCH_FORM, prompt }),
})

const noResume = { resumeFromSessionId: '' }

describe('toStartWorkflowInput (FR-016, FR-122)', () => {
  it('starts a run from nothing but a prompt, which is the whole of FR-122', () => {
    const submission = toStartWorkflowInput(profile(), filled(), noResume)

    expect(submission).toEqual({
      ok: true,
      input: { executionProfileId: PROFILE_ID, prompt: 'fix the failing test' },
    })
  })

  it('sends no overrides when nothing differs from the profile', () => {
    const submission = toStartWorkflowInput(profile(), filled(), noResume)

    expect(submission.ok && 'overrides' in submission.input).toBe(false)
  })

  it('refuses with no profile chosen, pointing at the picker', () => {
    const submission = toStartWorkflowInput(undefined, filled(), noResume)

    expect(submission).toEqual({
      ok: false,
      errors: { executionProfileId: profileFieldError('executionProfileId') },
    })
  })

  it('refuses an empty prompt, which is the one required input', () => {
    const submission = toStartWorkflowInput(profile(), filled(profile(), '   '), noResume)

    expect(submission.ok).toBe(false)
    expect(!submission.ok && submission.errors.prompt?.code).toBe('E_LAUNCH_PROMPT')
  })
})

describe('overrides are values that differ (FR-123)', () => {
  it('records only the fields the operator actually changed', () => {
    const submission = toStartWorkflowInput(
      profile(),
      { ...filled(), instanceType: 'm7i.4xlarge' },
      noResume,
    )

    expect(submission.ok && submission.input.overrides).toEqual({ instanceType: 'm7i.4xlarge' })
  })

  it('types a turn cap as a number rather than shipping the control’s text', () => {
    const submission = toStartWorkflowInput(profile(), { ...filled(), turnCap: '80' }, noResume)

    expect(submission.ok && submission.input.overrides).toEqual({ turnCap: 80 })
  })

  it('refuses a turn cap that is not a number rather than launching uncapped', () => {
    const submission = toStartWorkflowInput(profile(), { ...filled(), turnCap: '4o' }, noResume)

    expect(submission.ok).toBe(false)
    expect(!submission.ok && submission.errors.turnCap).toBeDefined()
  })

  it('refuses clearing a cap the profile sets, because the contract has no “no cap” override', () => {
    const submission = toStartWorkflowInput(profile(), { ...filled(), spendCap: '' }, noResume)

    expect(submission.ok).toBe(false)
    expect(!submission.ok && submission.errors.spendCap?.code).toBe('E_LAUNCH_SPEND_CAP')
  })

  it('refuses a locked field before the request is built, naming it', () => {
    const locked = profile({ lockedFields: ['model'] })
    const submission = toStartWorkflowInput(
      locked,
      { ...filled(locked), model: 'claude-sonnet-5' },
      noResume,
    )

    expect(submission.ok).toBe(false)
    expect(!submission.ok && submission.errors.model?.code).toBe('E_LAUNCH_LOCKED_MODEL')
  })

  it('never sends a locked field as an override, so the server is not asked twice', () => {
    const locked = profile({ lockedFields: ['model'] })
    const submission = toStartWorkflowInput(locked, filled(locked), noResume)

    expect(submission.ok && 'overrides' in submission.input).toBe(false)
  })
})

describe('the session reference (FR-016)', () => {
  it('carries a session id when one was given', () => {
    const submission = toStartWorkflowInput(profile(), filled(), {
      resumeFromSessionId: SESSION_ID,
    })

    expect(submission.ok && submission.input.resumeFromSessionId).toBe(SESSION_ID)
  })

  it('omits it entirely when blank — absent and empty are different to the schema', () => {
    const submission = toStartWorkflowInput(profile(), filled(), noResume)

    expect(submission.ok && 'resumeFromSessionId' in submission.input).toBe(false)
  })

  it('refuses something that is not a session id, pointing at its own field', () => {
    const submission = toStartWorkflowInput(profile(), filled(), {
      resumeFromSessionId: 'last-tuesday',
    })

    expect(submission.ok).toBe(false)
    expect(!submission.ok && submission.errors.resumeFromSessionId?.code).toBe(
      'E_LAUNCH_RESUME_FROM_SESSION_ID',
    )
  })
})

describe('field codes and issue paths', () => {
  it('produces a searchable code per field', () => {
    expect(profileFieldCode('resumeFromSessionId')).toBe('E_LAUNCH_RESUME_FROM_SESSION_ID')
    expect(profileFieldCode('prompt')).toBe('E_LAUNCH_PROMPT')
  })

  it('reads a nested override path back to the control it came from', () => {
    expect(profileFieldForIssuePath(['overrides', 'spendCap'])).toBe('spendCap')
    expect(profileFieldForIssuePath(['prompt'])).toBe('prompt')
  })

  it('answers undefined for a path that belongs to no control', () => {
    expect(profileFieldForIssuePath(['saveAsProfile', 'name'])).toBeUndefined()
  })
})
