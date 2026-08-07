import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { EMPTY_LAUNCH_FORM } from './launch-form-values'
import { ProfileLaunchFields } from './profile-launch-fields'
import { describeLaunchFieldLocks } from './profile-locks'
import type { LaunchProfileVersion } from './profile-prefill'
import { prefillFromProfile } from './profile-prefill'

const noop = () => undefined

const version = (lockedFields: readonly string[] = []): LaunchProfileVersion =>
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
    lockedFields,
    createdByUserId: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }) as LaunchProfileVersion

const render = (lockedFields: readonly string[] = []) => {
  const pinned = version(lockedFields)

  return renderToStaticMarkup(
    <ProfileLaunchFields
      locks={describeLaunchFieldLocks(pinned)}
      values={prefillFromProfile(pinned, EMPTY_LAUNCH_FORM)}
      errors={{}}
      onChange={noop}
    />,
  )
}

describe('ProfileLaunchFields (FR-122, FR-123)', () => {
  it('offers an editable control for every field the profile leaves open', () => {
    const markup = render()

    expect(markup).toContain('Instance size')
    expect(markup).toContain('<select')
    expect(markup).toContain('value="m7i.large"')
  })

  it('renders a locked field as locked rather than as an editable control', () => {
    const markup = render(['instanceType'])

    expect(markup).toContain('locked')
    expect(markup).not.toContain('value="m7i.large"')
  })

  it('still shows a locked field’s value, because the run is going to use it', () => {
    expect(render(['instanceType'])).toContain('m7i.large')
  })

  it('locks only what the version locks, leaving the rest editable', () => {
    const markup = render(['model'])

    expect(markup).toContain('value="m7i.large"')
    expect(markup.match(/data-state="locked"/g)).toHaveLength(1)
  })

  it('reads a locked cap the profile does not set as “no cap”', () => {
    const pinned = version(['turnCap'])
    const markup = renderToStaticMarkup(
      <ProfileLaunchFields
        locks={describeLaunchFieldLocks({ ...pinned, turnCap: null })}
        values={prefillFromProfile({ ...pinned, turnCap: null }, EMPTY_LAUNCH_FORM)}
        errors={{}}
        onChange={noop}
      />,
    )

    expect(markup).toContain('no cap')
  })

  it('puts a refusal under the control it belongs to', () => {
    const pinned = version()
    const markup = renderToStaticMarkup(
      <ProfileLaunchFields
        locks={describeLaunchFieldLocks(pinned)}
        values={prefillFromProfile(pinned, EMPTY_LAUNCH_FORM)}
        errors={{ turnCap: { code: 'E_LAUNCH_TURN_CAP', action: 'Enter a whole number.' } }}
        onChange={noop}
      />,
    )

    expect(markup).toContain('E_LAUNCH_TURN_CAP')
  })
})
