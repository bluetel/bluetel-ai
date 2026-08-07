import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { ConfigurationTrailReadouts } from './configuration-trail'
import { ConfigurationTrailCard } from './configuration-trail-card'

/**
 * The card is presentational. What is asserted is what the markup claims: that a change reaches the
 * page with the admin behind it, that there is **no control on it at all** — an append-only record
 * must not offer an edit — and that nothing here writes a literal colour or size (SC-015).
 */

const rows: readonly ConfigurationTrailReadouts[] = [
  {
    id: 'audit-1',
    entity: 'setup bundle',
    entityId: '0199a1f4-0000-7000-8000-0000000000bb',
    version: '3',
    action: 'replaced',
    at: '2026-08-05 09:14',
    actor: 'Ada Lovelace',
    detail: 'digest, sizeBytes',
  },
  {
    id: 'audit-2',
    entity: 'user',
    entityId: '0199a1f4-0000-7000-8000-0000000000cc',
    version: '—',
    action: 'role changed',
    at: '2026-08-04 08:00',
    actor: '—',
    detail: 'from, to, source',
  },
]

const markupFor = (over: Partial<Parameters<typeof ConfigurationTrailCard>[0]> = {}): string =>
  renderToStaticMarkup(<ConfigurationTrailCard rows={rows} {...over} />)

describe('ConfigurationTrailCard', () => {
  it('shows each recorded change with the admin behind it (FR-178)', () => {
    const markup = markupFor()

    for (const value of [
      'setup bundle',
      'replaced',
      '0199a1f4-0000-7000-8000-0000000000bb',
      'Ada Lovelace',
      '2026-08-05 09:14',
      'digest, sizeBytes',
    ]) {
      expect(markup).toContain(value)
    }
  })

  it('shows a platform-initiated change rather than hiding it', () => {
    // The row with no actor is in the list, which is what the `left join` on the server is for.
    expect(markupFor()).toContain('role changed')
  })

  it('offers no control, because the record cannot be edited or deleted (FR-178)', () => {
    const markup = markupFor()

    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('<input')
    expect(markup).not.toContain('<form')
  })

  it('says in its own words that a change with no admin was the platform’s', () => {
    expect(markupFor()).toContain('made by the platform itself')
  })

  it('distinguishes an empty trail from a read still in flight', () => {
    expect(markupFor({ rows: [] })).toContain('no configuration changes recorded')
    expect(markupFor({ rows: [], loading: true })).toContain('reading')
  })

  it('renders a refusal with a code and a next action rather than a dead end (FR-031)', () => {
    const markup = markupFor({
      rows: [],
      error: { code: 'E_NOT_ADMIN', action: 'Sign in with an administrator account.' },
    })

    expect(markup).toContain('E_NOT_ADMIN')
    expect(markup).toContain('Sign in with an administrator account.')
  })

  it('sets every value in data-mono under a label-mono caption (FR-026)', () => {
    // Seven readouts per row, over two rows.
    expect(markupFor().match(/type-data-mono/g)).toHaveLength(14)
  })

  it('writes no literal colour, size or radius (SC-015)', () => {
    const markup = markupFor()

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="[^"]*\d+(px|rem)/)
  })

  it('says it is reading rather than leaving the trail blank (FR-201)', () => {
    const markup = renderToStaticMarkup(<ConfigurationTrailCard rows={[]} loading />)

    expect(markup).toContain('data-note="loading"')
    expect(markup).not.toContain('no configuration changes recorded')
  })

  it('never claims nothing was recorded on a trail it could not read', () => {
    const markup = renderToStaticMarkup(
      <ConfigurationTrailCard rows={[]} error={{ code: 'E_UNEXPECTED', action: 'Retry once.' }} />,
    )

    expect(markup).toContain('E_UNEXPECTED')
    expect(markup).not.toContain('no configuration changes recorded')
  })
})
