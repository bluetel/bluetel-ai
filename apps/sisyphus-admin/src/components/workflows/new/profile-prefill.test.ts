import { describe, expect, it } from 'vitest'

import { EMPTY_LAUNCH_FORM } from './launch-form-values'
import type { LaunchProfile, LaunchProfileVersion } from './profile-prefill'
import {
  ABSENT_PROFILE_VALUE,
  findLaunchProfile,
  launchableProfiles,
  prefillFromProfile,
  profileLaunchOptions,
  profileVersionReadouts,
} from './profile-prefill'

const WORKSPACE_VERSION_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const BUNDLE_VERSION_ID = '01890a5d-ac96-774b-bcce-b302099a8058'

const version = (overrides: Partial<LaunchProfileVersion> = {}): LaunchProfileVersion =>
  ({
    id: 'version-1',
    executionProfileId: 'profile-1',
    version: 3,
    workspaceVersionId: WORKSPACE_VERSION_ID,
    setupBundleVersionId: BUNDLE_VERSION_ID,
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

const profile = (overrides: Partial<LaunchProfile> = {}): LaunchProfile =>
  ({
    id: 'profile-1',
    name: 'Payments',
    description: null,
    enabled: true,
    archivedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    currentVersion: version(),
    versionCount: 3,
    ...overrides,
  }) as LaunchProfile

describe('launchableProfiles', () => {
  it('keeps a profile that is enabled, unarchived and has a published version', () => {
    expect(launchableProfiles([profile()])).toHaveLength(1)
  })

  it('drops a disabled profile, because a launch on it would be refused (FR-124)', () => {
    expect(launchableProfiles([profile({ enabled: false })])).toHaveLength(0)
  })

  it('drops an archived profile', () => {
    expect(launchableProfiles([profile({ archivedAt: new Date() })])).toHaveLength(0)
  })

  it('drops a profile with nothing published, so the picker cannot offer an empty preset', () => {
    expect(launchableProfiles([profile({ currentVersion: undefined })])).toHaveLength(0)
  })
})

describe('profileLaunchOptions', () => {
  it('labels each option with the version a launch would pin (FR-126)', () => {
    expect(profileLaunchOptions([profile()])).toEqual([
      { value: 'profile-1', label: 'Payments — v3' },
    ])
  })

  it('offers only what can actually be launched', () => {
    expect(profileLaunchOptions([profile({ enabled: false })])).toEqual([])
  })
})

describe('findLaunchProfile', () => {
  it('finds a launchable profile by id', () => {
    expect(findLaunchProfile([profile()], 'profile-1')?.name).toBe('Payments')
  })

  it('does not find one that is no longer launchable, so a stale selection cannot be submitted', () => {
    expect(findLaunchProfile([profile({ enabled: false })], 'profile-1')).toBeUndefined()
  })
})

describe('prefillFromProfile (FR-122)', () => {
  it('fills in every value the profile carries', () => {
    const values = prefillFromProfile(version())

    expect(values).toMatchObject({
      workspaceSource: 'workspace',
      workspaceVersionId: WORKSPACE_VERSION_ID,
      setupBundleVersionId: BUNDLE_VERSION_ID,
      workflowType: 'delegated',
      model: 'claude-opus-5',
      instanceType: 'm7i.large',
      purchaseMode: 'spot',
      turnCap: '40',
      spendCap: '25.0000',
    })
  })

  it('leaves a cap the profile does not set blank rather than inventing a zero', () => {
    const values = prefillFromProfile(version({ turnCap: null, spendCap: null }))

    expect(values.turnCap).toBe('')
    expect(values.spendCap).toBe('')
  })

  it('keeps the prompt and the ticket reference — the operator wrote those, not the profile', () => {
    const values = prefillFromProfile(version(), {
      ...EMPTY_LAUNCH_FORM,
      prompt: 'fix the failing test',
      ticketReference: 'PAY-14',
    })

    expect(values.prompt).toBe('fix the failing test')
    expect(values.ticketReference).toBe('PAY-14')
  })

  it('does not paste the preamble into the prompt, which would make it editable (FR-157)', () => {
    const values = prefillFromProfile(version({ promptPreamble: 'You are working on payments.' }))

    expect(values.prompt).toBe('')
  })

  it('clears an ad hoc repository entered before a profile was chosen', () => {
    const values = prefillFromProfile(version(), {
      ...EMPTY_LAUNCH_FORM,
      workspaceSource: 'repository',
      repositoryUrl: 'git@host:org/repo.git',
      baseBranch: 'main',
    })

    expect(values.workspaceSource).toBe('workspace')
    expect(values.repositoryUrl).toBe('')
    expect(values.baseBranch).toBe('')
  })
})

describe('profileVersionReadouts', () => {
  it('names the version, so a run can be told apart from one on an earlier one (FR-125)', () => {
    expect(profileVersionReadouts(version())[0]).toEqual({ label: 'profile version', value: 'v3' })
  })

  it('reads an absent preamble as absent rather than as an empty readout', () => {
    const readouts = profileVersionReadouts(version())
    const preamble = readouts.find((readout) => readout.label === 'prompt preamble')

    expect(preamble?.value).toBe(ABSENT_PROFILE_VALUE)
  })
})
