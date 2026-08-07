import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { LaunchFormValues } from './launch-form-values'
import { EMPTY_LAUNCH_FORM } from './launch-form-values'
import { WorkspaceSourceFields } from './workspace-source-fields'

const noop = () => undefined

const workspaces = [
  { value: 'version-a', label: 'Payments — 2 repos' },
  { value: 'version-b', label: 'Website — 1 repo' },
]

const render = (
  values: Partial<LaunchFormValues> = {},
  props: Partial<Parameters<typeof WorkspaceSourceFields>[0]> = {},
) =>
  renderToStaticMarkup(
    <WorkspaceSourceFields
      values={{ ...EMPTY_LAUNCH_FORM, ...values }}
      errors={{}}
      onChange={noop}
      workspaces={workspaces}
      {...props}
    />,
  )

describe('WorkspaceSourceFields', () => {
  it('offers the two answers, curated first', () => {
    const markup = render()

    expect(markup.indexOf('A workspace somebody has set up')).toBeLessThan(
      markup.indexOf('One repository, entered here'),
    )
  })

  it('shows the workspace picker and no repository fields on the workspace answer', () => {
    const markup = render({ workspaceSource: 'workspace' })

    expect(markup).toContain('Payments — 2 repos')
    expect(markup).not.toContain('Base branch')
  })

  it('shows the repository fields and no workspace picker on the other answer', () => {
    const markup = render({ workspaceSource: 'repository' })

    expect(markup).toContain('Base branch')
    expect(markup).not.toContain('Payments — 2 repos')
  })

  it('never shows both at once, so which one the launch used is never ambiguous', () => {
    const workspaceMarkup = render({ workspaceSource: 'workspace' })
    const repositoryMarkup = render({ workspaceSource: 'repository' })

    expect(workspaceMarkup).not.toContain('git@host:org/repo.git')
    expect(repositoryMarkup).not.toContain('Choose a workspace')
  })

  it('says so, and disables the picker, when no workspace is available to choose', () => {
    const markup = render({ workspaceSource: 'workspace' }, { workspaces: [] })

    expect(markup).toContain('No enabled workspace is available')
    expect(markup).toContain('disabled')
  })

  it('says the run pins the version, which is what makes a later edit harmless (FR-125)', () => {
    expect(render()).toContain('pins the version')
  })

  it('renders a refusal against the control it belongs to', () => {
    const markup = render(
      { workspaceSource: 'repository' },
      { errors: { repositoryUrl: { code: 'E_LAUNCH_REPOSITORY_URL', action: 'Enter a remote.' } } },
    )

    expect(markup).toContain('E_LAUNCH_REPOSITORY_URL')
    expect(markup).toContain('data-state="invalid"')
  })

  it('carries no literal colour, size or radius (SC-015)', () => {
    expect(render()).not.toMatch(/#[0-9a-fA-F]{3,8}|\d+(?:px|rem)/)
  })
})
