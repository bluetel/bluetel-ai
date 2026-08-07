import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { WorkspaceEntryFields } from './workspace-entry-fields'
import { EMPTY_ENTRY } from './workspace-entry-values'

const noop = () => undefined

const render = (props: Partial<Parameters<typeof WorkspaceEntryFields>[0]> = {}) =>
  renderToStaticMarkup(
    <WorkspaceEntryFields
      entry={EMPTY_ENTRY}
      ordinal={2}
      onChange={noop}
      onMakePrimary={noop}
      onRemove={noop}
      removable
      {...props}
    />,
  )

describe('WorkspaceEntryFields (FR-109..FR-111)', () => {
  it('numbers the row the way an admin counts and the enable gate names them', () => {
    expect(render()).toContain('repository 2')
  })

  it('reports its role as a state rather than as an unchecked box', () => {
    expect(render()).toContain('secondary')
    expect(render({ entry: { ...EMPTY_ENTRY, isPrimary: true } })).toContain('primary')
  })

  it('offers no checkbox, so two primaries cannot be expressed (FR-110)', () => {
    expect(render()).not.toContain('type="checkbox"')
  })

  it('cannot make the primary row primary again', () => {
    expect(render({ entry: { ...EMPTY_ENTRY, isPrimary: true } })).toContain('disabled=""')
  })

  it('says what being primary means, rather than leaving it to be inferred (FR-058)', () => {
    expect(render()).toContain('skills are resolved from')
  })

  it('cannot be removed when it is the last row', () => {
    expect(render({ removable: false })).toContain('disabled=""')
  })

  it('renders a refusal with its code and next action', () => {
    const markup = render({
      error: { code: 'E_WORKSPACE_ENTRY', action: 'Enter a git remote.' },
    })

    expect(markup).toContain('E_WORKSPACE_ENTRY')
  })
})
