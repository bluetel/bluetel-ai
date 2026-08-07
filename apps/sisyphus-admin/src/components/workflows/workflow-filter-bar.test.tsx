import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { WorkflowFilterBar } from './workflow-filter-bar'
import { EMPTY_FILTERS } from './workflow-filters'

/**
 * The bar is controlled, so what is asserted here is what it *offers*: every state and type in the
 * closed vocabularies, a field per id filter, a refusal to apply an id that is not one, and the
 * clear control appearing only when there is something to clear.
 *
 * The behaviour of a click is not asserted from markup — there is no testing library — so the
 * transitions the handlers perform are covered by `workflow-filters.test.ts`, which is where the
 * functions they call live.
 */

const noop = () => undefined

const render = (filters = EMPTY_FILTERS) =>
  renderToStaticMarkup(
    <WorkflowFilterBar filters={filters} onChange={noop} onApply={noop} onClear={noop} />,
  )

describe('WorkflowFilterBar', () => {
  it('offers every workflow state as a toggle, so the vocabulary is visible rather than hidden in a menu', () => {
    const markup = render()

    for (const label of [
      'Queued',
      'Provisioning',
      'Running',
      'Paused',
      'Parked resumable',
      'Succeeded',
      'Failed',
      'Capped',
      'Cancelled',
      'Needs attention',
    ]) {
      expect(markup).toContain(label)
    }
  })

  it('offers every workflow type', () => {
    const markup = render()

    expect(markup).toContain('Delegated')
    expect(markup).toContain('Autonomous')
    expect(markup).toContain('Review')
  })

  it('reports which toggles are pressed, so selection is not carried by colour alone', () => {
    const markup = render({ ...EMPTY_FILTERS, states: ['running'], type: 'review' })

    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(2)
  })

  it('offers a field for every filter FR-013 names', () => {
    const markup = render()

    for (const label of [
      'Ticket reference or result branch',
      'Repository URL',
      'Initiating user id',
      'Originating integration id',
      'Execution profile id',
      'Workspace id',
      'Setup bundle id',
    ]) {
      expect(markup).toContain(label)
    }
  })

  it('marks an id field holding something that is not an identifier, with a code and a next action', () => {
    const markup = render({ ...EMPTY_FILTERS, workspaceId: 'the platform one' })

    expect(markup).toContain('E_NOT_AN_IDENTIFIER')
    expect(markup).toContain('Paste the identifier')
  })

  it('refuses to apply while an id field is invalid, rather than sending a doomed query', () => {
    const markup = render({ ...EMPTY_FILTERS, workspaceId: 'not an id' })

    expect(markup).toContain('Apply filters')
    expect(markup).toMatch(/Apply filters/)
    expect(markup).toContain('disabled=""')
  })

  it('lets a valid filter set be applied', () => {
    const markup = render({ ...EMPTY_FILTERS, states: ['failed'] })

    expect(markup).not.toContain('disabled=""')
  })

  it('offers to clear only when something is narrowed', () => {
    expect(render()).not.toContain('Clear')
    expect(render({ ...EMPTY_FILTERS, search: 'ABC-12' })).toContain('Clear')
  })

  it('keeps button labels sentence-case Archivo rather than uppercase mono (FR-026)', () => {
    const markup = render()

    expect(markup).toContain('type-label-button')
    expect(markup).not.toContain('>QUEUED<')
  })

  it('writes no literal colour, size or radius (SC-015)', () => {
    const markup = render({ ...EMPTY_FILTERS, search: 'ABC-12' })

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="[^"]*\d+(px|rem)/)
  })
})
