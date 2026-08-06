import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { WorkspaceEditor } from './workspace-editor'
import { EMPTY_WORKSPACE } from './workspace-entry-values'

const noop = () => undefined

const render = (props: Partial<Parameters<typeof WorkspaceEditor>[0]> = {}) =>
  renderToStaticMarkup(
    <WorkspaceEditor
      draft={EMPTY_WORKSPACE}
      errors={{}}
      onChange={noop}
      onSubmit={noop}
      {...props}
    />,
  )

describe('WorkspaceEditor (FR-125, FR-127)', () => {
  it('offers to create when no version number was given', () => {
    expect(render()).toContain('Create workspace')
  })

  it('says which version an edit will publish, rather than saying “save”', () => {
    const markup = render({ nextVersion: 4 })

    expect(markup).toContain('Publish version 4')
    expect(markup).not.toContain('>Save<')
  })

  it('says an edit leaves running workflows on the version they pinned (FR-125)', () => {
    expect(render({ nextVersion: 4 })).toContain('stays on the version it pinned')
  })

  it('says a new workspace arrives disabled, so that reads as design rather than as a bug', () => {
    expect(render()).toContain('arrives disabled')
  })

  it('counts the repositories in its header chip', () => {
    expect(render()).toContain('repositories 1')
  })

  it('cannot remove the last repository, because a version must contain at least one', () => {
    expect(render()).toContain('Remove')
    expect(render()).toContain('disabled=""')
  })

  it('renders a list-level refusal with its code and next action', () => {
    const markup = render({
      errors: { entries: { code: 'E_WORKSPACE_ENTRIES', action: 'Mark exactly one primary.' } },
    })

    expect(markup).toContain('E_WORKSPACE_ENTRIES')
    expect(markup).toContain('Mark exactly one primary.')
  })

  it('puts a row-level refusal on the row it belongs to', () => {
    const markup = render({
      errors: { rows: { 0: { code: 'E_WORKSPACE_ENTRY', action: 'Enter a git remote.' } } },
    })

    expect(markup).toContain('E_WORKSPACE_ENTRY')
  })
})
