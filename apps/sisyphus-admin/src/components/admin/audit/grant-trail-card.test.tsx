import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { GrantTrailReadouts } from './grant-trail'
import { GrantTrailCard } from './grant-trail-card'

/**
 * The card is presentational. What is asserted is what the markup claims: that both sides of the
 * history reach the page, that there is **no control on it at all** — an append-only record must not
 * offer an edit — and that nothing here writes a literal colour or size (SC-015).
 */

const rows: readonly GrantTrailReadouts[] = [
  {
    id: 'grant-live',
    profile: 'API maintenance',
    state: 'live',
    grantedAt: '2026-08-01 09:00',
    grantedBy: '0199a1f4-0000-7000-8000-0000000000ef',
    revokedAt: 'never',
    revokedBy: '—',
  },
  {
    id: 'grant-revoked',
    profile: 'Client billing',
    state: 'revoked',
    grantedAt: '2026-07-01 09:00',
    grantedBy: '0199a1f4-0000-7000-8000-0000000000ef',
    revokedAt: '2026-08-05 09:00',
    revokedBy: '0199a1f4-0000-7000-8000-00000000ffff',
  },
]

const markupFor = (over: Partial<Parameters<typeof GrantTrailCard>[0]> = {}): string =>
  renderToStaticMarkup(<GrantTrailCard rows={rows} {...over} />)

describe('GrantTrailCard', () => {
  it('shows every grant and every revocation, with the admin behind each', () => {
    const markup = markupFor()

    for (const value of [
      'API maintenance',
      'Client billing',
      'live',
      'revoked',
      '2026-08-05 09:00',
      '0199a1f4-0000-7000-8000-00000000ffff',
    ]) {
      expect(markup).toContain(value)
    }
  })

  it('offers no control, because the record cannot be edited or deleted (FR-184)', () => {
    const markup = markupFor()

    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('<input')
    expect(markup).not.toContain('<form')
  })

  it('says why the list is both the access set and its history', () => {
    expect(markupFor()).toContain('A revocation is a write, never a delete')
  })

  it('distinguishes an empty history from a read still in flight', () => {
    expect(markupFor({ rows: [] })).toContain('no access changes recorded for this user')
    expect(markupFor({ rows: [], loading: true })).toContain('reading')
  })

  it('renders a refusal with a code and a next action rather than a dead end (FR-031)', () => {
    const markup = markupFor({
      rows: [],
      error: { code: 'E_TARGET_NOT_FOUND', action: 'Reload the list.' },
    })

    expect(markup).toContain('E_TARGET_NOT_FOUND')
    expect(markup).toContain('Reload the list.')
  })

  it('sets every value in data-mono under a label-mono caption (FR-026)', () => {
    const markup = markupFor()

    // Six readouts per row, over two rows.
    expect(markup.match(/type-data-mono/g)).toHaveLength(12)
  })

  it('writes no literal colour, size or radius (SC-015)', () => {
    const markup = markupFor()

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="[^"]*\d+(px|rem)/)
  })

  it('says it is reading rather than leaving the trail blank (FR-201)', () => {
    const markup = renderToStaticMarkup(<GrantTrailCard rows={[]} loading />)

    expect(markup).toContain('data-note="loading"')
    expect(markup).not.toContain('no access changes recorded for this user')
  })

  it('never claims nothing was recorded on a trail it could not read', () => {
    const markup = renderToStaticMarkup(
      <GrantTrailCard rows={[]} error={{ code: 'E_UNEXPECTED', action: 'Retry once.' }} />,
    )

    expect(markup).toContain('E_UNEXPECTED')
    expect(markup).not.toContain('no access changes recorded for this user')
  })
})
