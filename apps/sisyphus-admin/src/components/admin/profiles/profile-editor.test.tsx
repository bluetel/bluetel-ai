import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ProfileEditor } from './profile-editor'
import { EMPTY_PROFILE } from './profile-form-values'

const noop = () => undefined

const render = (props: Partial<Parameters<typeof ProfileEditor>[0]> = {}) =>
  renderToStaticMarkup(
    <ProfileEditor
      draft={EMPTY_PROFILE}
      errors={{}}
      onChange={noop}
      onSubmit={noop}
      workspaces={[{ value: 'workspace-version-9', label: 'Payments — v3, 2 repos' }]}
      bundles={[{ value: 'bundle-version-2', label: 'Payments toolchain — v2' }]}
      {...props}
    />,
  )

describe('ProfileEditor (FR-121, FR-123, FR-125)', () => {
  it('offers to create when no version number was given', () => {
    expect(render()).toContain('Create profile')
  })

  it('says which version an edit will publish, rather than saying “save”', () => {
    const markup = render({ nextVersion: 4 })

    expect(markup).toContain('Publish version 4')
    expect(markup).not.toContain('>Save<')
  })

  it('says an edit leaves running workflows on the version they recorded (FR-125)', () => {
    expect(render({ nextVersion: 4 })).toContain('keeps the version it recorded at launch')
  })

  it('says a new profile arrives disabled and granted to nobody (FR-124)', () => {
    expect(render()).toContain('disabled and granted to nobody')
  })

  it('says the workspace version is pinned, so a later workspace edit is not inherited', () => {
    expect(render()).toContain('does not re-point this profile')
  })

  it('counts the locked fields in its header chip (FR-123)', () => {
    expect(render()).toContain('locked 0 of 6')
    expect(render({ draft: { ...EMPTY_PROFILE, lockedFields: ['model'] } })).toContain(
      'locked 1 of 6',
    )
  })

  it('says what locking does on the launch form, rather than presenting it as a preference', () => {
    expect(render()).toContain('shown on the launch form as locked and refused if it is changed')
  })

  it('reports each lock’s own state on its control (FR-023)', () => {
    const markup = render({ draft: { ...EMPTY_PROFILE, lockedFields: ['spendCap'] } })

    expect(markup).toContain('Spend cap: locked')
    expect(markup).toContain('Model: open')
  })

  it('renders a field refusal with its code and next action', () => {
    const markup = render({
      errors: { turnCap: { code: 'E_PROFILE_TURN_CAP', action: 'Enter a whole number.' } },
    })

    expect(markup).toContain('E_PROFILE_TURN_CAP')
  })
})
