import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { GrantCandidate } from './issue-grant-form'
import { IssueGrantForm } from './issue-grant-form'

const noop = () => undefined

const candidates: readonly GrantCandidate[] = [
  {
    id: '0199a1f4-0000-7000-8000-000000000080',
    displayName: 'An Engineer',
    email: 'engineer@bluetel.co.uk',
  },
  {
    id: '0199a1f4-0000-7000-8000-000000000081',
    displayName: 'Another Engineer',
    email: 'other@bluetel.co.uk',
  },
]

const render = (props: Partial<Parameters<typeof IssueGrantForm>[0]> = {}) =>
  renderToStaticMarkup(
    <IssueGrantForm
      candidates={candidates}
      selectedUserId=""
      onSelect={noop}
      onSubmit={noop}
      {...props}
    />,
  )

describe('IssueGrantForm', () => {
  it('lists the candidates by name and address', () => {
    const markup = render()

    expect(markup).toContain('An Engineer — engineer@bluetel.co.uk')
    expect(markup).toContain('Another Engineer — other@bluetel.co.uk')
  })

  it('counts the candidates in the header chip', () => {
    expect(render()).toContain('candidates 2')
  })

  it('labels the picker above it, never as a placeholder standing in for a label', () => {
    const markup = render()
    const labelTarget = /for="([^"]+)"/.exec(markup)?.[1]

    expect(labelTarget).toBeDefined()
    expect(markup).toContain(`id="${String(labelTarget)}"`)
    expect(markup.indexOf('<label')).toBeLessThan(markup.indexOf('<select'))
  })

  it('holds the page’s one primary button, and it is this one', () => {
    const markup = render()

    expect(markup).toContain('Grant access')
    expect(markup.match(/bg-signal /g)).toHaveLength(1)
  })

  it('refuses to submit until a user is chosen', () => {
    expect(render()).toContain('data-state="disabled"')
    expect(render({ selectedUserId: candidates[0]?.id ?? '' })).toContain('data-state="idle"')
  })

  it('disables the picker when nobody is left to grant', () => {
    expect(render({ candidates: [] })).toContain('disabled')
  })

  it('renders a refusal with its code and next action, bound to the picker', () => {
    const markup = render({
      error: { code: 'E_GRANT_TARGET_NOT_FOUND', action: 'Reload the access list and pick again.' },
    })
    const describedBy = /aria-describedby="([^"]+)"/.exec(markup)?.[1]

    expect(markup).toContain('E_GRANT_TARGET_NOT_FOUND')
    expect(describedBy).toBeDefined()
    expect(markup).toContain(`id="${String(describedBy)}"`)
    expect(markup).toContain('data-state="invalid"')
  })

  it('reports its own state on the picker, the way every interactive element does', () => {
    expect(render()).toContain('data-state="valid"')
    expect(render()).toContain('aria-invalid="false"')
  })

  it('replaces the label with a live readout while in flight, and shows no spinner', () => {
    const markup = render({ startedAt: 1000 })

    expect(markup).toContain('Granting 0:00')
    expect(markup).toContain('aria-busy="true"')
    expect(markup).not.toMatch(/spinner|animate-spin/)
  })

  it('carries the shared focus ring rather than a second one', () => {
    expect(render()).toContain('focus-ring')
  })

  it('carries no literal colour, size or radius', () => {
    expect(render()).not.toMatch(/#[0-9a-fA-F]{3,8}|\d+(?:px|rem)/)
  })
})
