import { readFileSync } from 'node:fs'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { ConfigurationFilters } from './configuration-filters'
import { EMPTY_CONFIGURATION_SCOPE } from './configuration-scope'

/**
 * The filter card holds no state and issues no query, so every state it can be in is reachable from
 * props alone and testable with `renderToStaticMarkup` — there is no testing library in this app.
 *
 * What is asserted is what only this component can get wrong: that a value it is refusing is marked
 * and blocks the read rather than being sent, that the picker offers the vocabulary the procedure
 * accepts, and that the select is the app's one select rather than a second one styled here.
 */

const ID = '0199a1f4-0000-7000-8000-0000000000ab'

const source = readFileSync(new URL('./configuration-filters.tsx', import.meta.url), 'utf8')

const markupFor = (over: Partial<Parameters<typeof ConfigurationFilters>[0]> = {}): string =>
  renderToStaticMarkup(
    <ConfigurationFilters
      draft={EMPTY_CONFIGURATION_SCOPE}
      onChange={vi.fn()}
      onApply={vi.fn()}
      {...over}
    />,
  )

describe('ConfigurationFilters', () => {
  it('offers every entity class the procedure accepts', () => {
    const markup = markupFor()

    for (const label of ['setup bundle', 'workspace', 'execution profile', 'integration']) {
      expect(markup).toContain(label)
    }
  })

  it('offers "anything" as the unfiltered choice rather than leaving the picker empty', () => {
    expect(markupFor()).toContain('anything')
  })

  it('labels every control above it, never as a placeholder standing in for one (FR-031)', () => {
    const markup = markupFor()

    for (const label of ['Kind of thing', 'Identifier', 'Changed by']) {
      expect(markup).toContain(label)
    }
  })

  it('marks an identifier it will not send, with a code and a next action', () => {
    const markup = markupFor({
      draft: { ...EMPTY_CONFIGURATION_SCOPE, entityId: 'bundle-1' },
    })

    expect(markup).toContain('E_NOT_AN_IDENTIFIER')
    expect(markup).toContain('Paste the identifier from the record, or clear the field.')
  })

  it('marks a bad actor id separately from a bad entity id', () => {
    const markup = markupFor({
      draft: { ...EMPTY_CONFIGURATION_SCOPE, actorUserId: 'ada' },
    })

    expect(markup).toContain('Paste the identifier from the user record, or clear the field.')
  })

  it('disables the read while a field is refusing, so nothing unusable is sent', () => {
    expect(markupFor({ draft: { ...EMPTY_CONFIGURATION_SCOPE, entityId: 'ada' } })).toContain(
      'disabled',
    )
    expect(markupFor()).not.toContain('disabled=""')
  })

  it('offers a clear only once something is narrowed', () => {
    expect(markupFor()).not.toContain('Clear')
    expect(markupFor({ draft: { ...EMPTY_CONFIGURATION_SCOPE, entityId: ID } })).toContain('Clear')
  })

  it('uses the app’s one select rather than styling a second (FR-033)', () => {
    expect(source).toContain('LaunchSelect')
    expect(source).toContain("from '@sisyphus-admin/components/workflows/new'")
    expect(source).not.toContain('<select')
  })

  it('writes no literal colour, size or radius (SC-015)', () => {
    const markup = markupFor()

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="[^"]*\d+(px|rem)/)
  })
})
