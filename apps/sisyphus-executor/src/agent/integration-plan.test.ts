/**
 * T196 — reading an integration plan out of a block.
 *
 * The interesting assertion is the one about a **missing** order: it is passed through absent, so
 * that `requirePromotionOrder` is what halts and its message names `sisyphus-integration` and the
 * step. A halt raised here would say "order is missing" about a JSON key, which tells an operator
 * nothing about which file to edit.
 */

import { describe, expect, it } from 'vitest'

import { readIntegrationPlan } from './integration-plan'

const STEP = { entryId: 'entry-api', name: 'merge', instruction: 'Merge the pull request.' }

describe('readIntegrationPlan — what the agent stated', () => {
  it('reads an order and a list of steps', () => {
    expect(
      readIntegrationPlan({ order: { entryIds: ['entry-api', 'entry-web'] }, steps: [STEP] }),
    ).toStrictEqual({
      kind: 'read',
      plan: { order: { entryIds: ['entry-api', 'entry-web'] }, steps: [STEP] },
    })
  })

  it('reads an empty step list as an empty step list', () => {
    // A legitimate outcome: `statementFor` reports "prescribes no integration steps for this run".
    expect(readIntegrationPlan({ steps: [] })).toStrictEqual({ kind: 'read', plan: { steps: [] } })
  })

  it('passes a missing order through for requirePromotionOrder to halt on (FR-117)', () => {
    expect(readIntegrationPlan({ steps: [STEP] })).toStrictEqual({
      kind: 'read',
      plan: { steps: [STEP] },
    })
  })

  it('passes an order object that names no entryIds through as an empty declaration', () => {
    expect(readIntegrationPlan({ order: {} })).toStrictEqual({ kind: 'read', plan: { order: {} } })
  })
})

describe('readIntegrationPlan — what it refuses', () => {
  it('reports a block answering neither question as empty', () => {
    expect(readIntegrationPlan({})).toStrictEqual({ kind: 'empty' })
  })

  it('refuses an order that is not a list of entry ids', () => {
    expect(readIntegrationPlan({ order: { entryIds: 'entry-api, entry-web' } }).kind).toBe(
      'unusable',
    )
  })

  it('refuses a step with no instruction rather than performing a blank one', () => {
    const reading = readIntegrationPlan({ steps: [{ entryId: 'entry-api', name: 'merge' }] })

    expect(reading.kind).toBe('unusable')
    expect(reading.kind === 'unusable' ? reading.problems.join(' ') : '').toContain(
      "says nothing about what to do, in the skill's words",
    )
  })

  it('refuses a step that names no entry', () => {
    const reading = readIntegrationPlan({
      steps: [{ name: 'merge', instruction: 'Merge it.' }],
    })

    expect(reading.kind).toBe('unusable')
    expect(reading.kind === 'unusable' ? reading.problems.join(' ') : '').toContain(
      'does not name the workspace entry',
    )
  })
})
