import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { EMPTY_LAUNCH_FORM } from './launch-form-values'
import { ProfileLaunchForm } from './profile-launch-form'
import { describeLaunchFieldLocks } from './profile-locks'
import type { LaunchProfileVersion } from './profile-prefill'
import { prefillFromProfile, profileVersionReadouts } from './profile-prefill'

const noop = () => undefined

const version: LaunchProfileVersion = {
  id: 'version-1',
  executionProfileId: 'profile-1',
  version: 4,
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
} as LaunchProfileVersion

const render = (props: Partial<Parameters<typeof ProfileLaunchForm>[0]> = {}) =>
  renderToStaticMarkup(
    <ProfileLaunchForm
      profiles={[{ value: 'profile-1', label: 'Payments — v4' }]}
      executionProfileId=""
      onSelectProfile={noop}
      readouts={[]}
      locks={[]}
      values={EMPTY_LAUNCH_FORM}
      errors={{}}
      onChange={noop}
      resumeFromSessionId=""
      onResumeChange={noop}
      onSubmit={noop}
      {...props}
    />,
  )

const chosen = (props: Partial<Parameters<typeof ProfileLaunchForm>[0]> = {}) =>
  render({
    executionProfileId: 'profile-1',
    readouts: profileVersionReadouts(version),
    locks: describeLaunchFieldLocks(version),
    values: prefillFromProfile(version, EMPTY_LAUNCH_FORM),
    ...props,
  })

describe('ProfileLaunchForm (FR-016, FR-122)', () => {
  it('asks its three questions in the order they are answered', () => {
    const markup = render()

    expect(markup.indexOf('which profile')).toBeLessThan(markup.indexOf('what it will use'))
    expect(markup.indexOf('what it will use')).toBeLessThan(markup.indexOf('what to do'))
  })

  it('counts what is available to choose in the header chip', () => {
    expect(render()).toContain('profiles 1')
  })

  it('says the prompt is the only thing left to supply, which is FR-122 in words', () => {
    expect(render()).toContain('the prompt is the only thing left to supply')
  })

  it('reports that nothing is prefilled until a profile is chosen', () => {
    expect(render()).toContain('awaiting profile')
  })

  it('shows the pinned version once a profile is chosen (FR-125, FR-126)', () => {
    const markup = chosen()

    expect(markup).toContain('prefilled')
    expect(markup).toContain('profile version')
    expect(markup).toContain('v4')
  })

  it('says an edit to the profile leaves this run where it is', () => {
    expect(chosen()).toContain('leaves this run on the version below')
  })

  it('holds exactly one primary button', () => {
    expect(chosen().match(/data-state="idle"/g)?.length).toBeGreaterThan(0)
    expect(chosen()).toContain('Launch run')
  })

  it('cannot be launched before a profile is chosen', () => {
    expect(render()).toContain('disabled=""')
  })
})

describe('the session reference (FR-016)', () => {
  it('is offered, and says it starts a new run rather than continuing one', () => {
    const markup = chosen()

    expect(markup).toContain('Restore a stored session')
    expect(markup).toContain('not the same act as carrying on with an existing one')
  })

  it('says where continuing an existing run is done instead', () => {
    expect(chosen()).toContain('continue a run from its own page')
  })
})

describe('refusals', () => {
  it('renders a whole-request refusal with its code and next action', () => {
    const markup = chosen({
      error: { code: 'E_LAUNCH_REFUSED', action: 'Nothing was started.' },
    })

    expect(markup).toContain('E_LAUNCH_REFUSED')
    expect(markup).toContain('Nothing was started.')
  })

  it('explains an unreadable profile list without naming a permission (FR-190)', () => {
    const markup = render({
      catalogueError: {
        code: 'E_PROFILE_CATALOGUE_UNAVAILABLE',
        action: 'Ask an admin to grant you an execution profile, then reload this page.',
      },
    })

    expect(markup).toContain('E_PROFILE_CATALOGUE_UNAVAILABLE')
    expect(markup).not.toContain('permission')
  })

  it('says it is reading rather than claiming the caller has no profile (FR-201)', () => {
    const markup = render({ profiles: [], loading: true })

    expect(markup).toContain('data-note="loading"')
    expect(markup).toContain('reading the profiles you may launch on')
    expect(markup).not.toContain('no execution profile has been granted to you')
  })

  it('reads as reading in the chip and in the picker, not as “profiles 0”', () => {
    const markup = render({ profiles: [], loading: true })

    expect(markup).toContain('reading')
    expect(markup).not.toContain('profiles 0')
    expect(markup).not.toContain('No execution profile is available to you')
  })

  it('states the empty case only once the read has settled', () => {
    const markup = render({ profiles: [] })

    expect(markup).toContain('data-note="empty"')
    expect(markup).toContain('no execution profile has been granted to you')
  })

  it('withholds the empty case when the catalogue read was refused', () => {
    const markup = render({
      profiles: [],
      catalogueError: { code: 'E_PROFILE_CATALOGUE_UNAVAILABLE', action: 'Ask an admin.' },
    })

    expect(markup).toContain('E_PROFILE_CATALOGUE_UNAVAILABLE')
    expect(markup).not.toContain('no execution profile has been granted to you')
  })
})
