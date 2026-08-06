import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { WorkspaceCard } from './workspace-card'
import type { WorkspaceReadouts } from './workspace-listing'

const noop = () => undefined

const workspace: WorkspaceReadouts = {
  id: 'workspace-1',
  name: 'Payments',
  description: 'The payments repositories',
  state: 'enabled',
  version: 'v3 of 7',
  publishedAt: '2026-02-01 09:30',
  entryCount: '2',
  currentVersionId: 'version-3',
  entries: [
    {
      id: 'entry-1',
      repositoryUrl: 'git@host:acme/api.git',
      baseBranch: 'main',
      subdirectory: 'api',
      role: 'primary',
    },
  ],
  editable: true,
  enabled: true,
}

const render = (props: Partial<Parameters<typeof WorkspaceCard>[0]> = {}) =>
  renderToStaticMarkup(
    <WorkspaceCard
      workspace={workspace}
      cloneName=""
      onCloneNameChange={noop}
      onClone={noop}
      onEdit={noop}
      onSetEnabled={noop}
      {...props}
    />,
  )

describe('WorkspaceCard (FR-125, FR-127, FR-128)', () => {
  it('leads with the version, not with the repository list', () => {
    expect(render()).toContain('v3 of 7')
  })

  it('shows the version id, which is what a run records', () => {
    expect(render()).toContain('version-3')
  })

  it('says an edit publishes the next version rather than changing this one', () => {
    expect(render()).toContain('Editing publishes the next version')
  })

  it('offers disabling rather than deletion, and offers no delete at all (FR-128)', () => {
    const markup = render()

    expect(markup).toContain('Disable')
    expect(markup).not.toContain('Delete')
  })

  it('offers to enable a disabled workspace', () => {
    expect(render({ workspace: { ...workspace, enabled: false, state: 'disabled' } })).toContain(
      'Enable',
    )
  })

  it('refuses to offer an edit on an archived workspace', () => {
    const markup = render({ workspace: { ...workspace, editable: false } })

    expect(markup).toContain('disabled=""')
  })

  it('will not clone until the copy has been named', () => {
    expect(render()).toContain('name the copy')
  })
})
