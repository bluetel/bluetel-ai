import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ProfileCard } from './profile-card'
import type { ProfileReadouts } from './profile-listing'

const noop = () => undefined

const profile: ProfileReadouts = {
  id: 'profile-1',
  name: 'Payments',
  description: 'The payments preset',
  state: 'disabled',
  version: 'v3 of 7',
  currentVersionId: 'version-3',
  publishedAt: '2026-02-01 09:30',
  workspaceVersionId: 'workspace-version-9',
  setupBundleVersionId: 'bundle-version-2',
  model: 'claude-opus-5',
  instanceType: 'm7i.large',
  purchaseMode: 'spot',
  turnCap: '40',
  spendCap: '25.0000',
  defaultWorkflowType: 'delegated',
  promptPreamble: '—',
  lockedFields: 'model, spendCap',
  enabled: false,
  editable: true,
  published: true,
}

const render = (props: Partial<Parameters<typeof ProfileCard>[0]> = {}) =>
  renderToStaticMarkup(
    <ProfileCard
      profile={profile}
      cloneName=""
      onCloneNameChange={noop}
      onClone={noop}
      onEdit={noop}
      onSetEnabled={noop}
      onShowReferences={noop}
      {...props}
    />,
  )

describe('ProfileCard (FR-125, FR-126, FR-127, FR-128)', () => {
  it('leads with the version, not with the model', () => {
    expect(render()).toContain('v3 of 7')
  })

  it('shows the version id, which is what a run records (FR-126)', () => {
    expect(render()).toContain('version-3')
  })

  it('names the locked fields, because they are refused on every run (FR-123)', () => {
    expect(render()).toContain('model, spendCap')
  })

  it('says an edit publishes the next version rather than changing this one', () => {
    expect(render()).toContain('Editing publishes the next version')
  })

  it('offers disabling rather than deletion, and offers no delete at all (FR-128)', () => {
    const markup = render()

    expect(markup).toContain('Enable')
    expect(markup).not.toContain('Delete')
  })

  it('links to who holds the profile, which is a separately audited act (FR-184)', () => {
    expect(render()).toContain('/admin/profiles/profile-1/access')
  })

  it('offers to read what depends on it rather than reading it for every card (FR-127)', () => {
    expect(render()).toContain('What depends on this')
  })

  it('shows the sweep once it has been read', () => {
    const markup = render({
      references: '1 live grant · 0 integrations · 2 of 40 runs still non-terminal',
    })

    expect(markup).toContain('referenced by')
    expect(markup).not.toContain('What depends on this')
  })
})

describe('the FR-124 refusal', () => {
  const failures = [
    {
      element: 'setup_bundle' as const,
      detail: 'the setup bundle Payments toolchain (version 3) is disabled',
      error: { code: 'E_PROFILE_ENABLE_SETUP_BUNDLE', action: 'Enable the setup bundle.' },
    },
    {
      element: 'setup_bundle' as const,
      detail: 'the setup bundle Fraud checks (version 2) is disabled',
      error: { code: 'E_PROFILE_ENABLE_SETUP_BUNDLE', action: 'Enable the setup bundle.' },
    },
  ]

  it('renders one field error per failing element rather than flattening the list', () => {
    const markup = render({ enableFailures: failures })

    expect(markup).toContain('Payments toolchain')
    expect(markup).toContain('Fraud checks')
  })

  it('keeps the gate’s own sentence, so the failing element stays named', () => {
    expect(render({ enableFailures: failures })).toContain('Fraud checks (version 2)')
  })

  it('carries a next action beside each one, never a bare restatement', () => {
    expect(render({ enableFailures: failures })).toContain('Enable the setup bundle.')
  })

  it('renders nothing extra when the gate passed', () => {
    expect(render()).not.toContain('E_PROFILE_ENABLE')
  })
})
