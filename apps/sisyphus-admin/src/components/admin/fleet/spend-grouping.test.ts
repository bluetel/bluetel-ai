import { describe, expect, it } from 'vitest'

import {
  DEFAULT_FLEET_GROUPING,
  FLEET_SPEND_GROUPINGS,
  GROUPING_LABELS,
  isFleetGrouping,
  parseSpendGrouping,
  toSpendSummaryInput,
} from './spend-grouping'

/**
 * FR-156 in the URL. The default is collective, and — the part that matters — the individual
 * grouping is not reachable through this screen **by any input**, not merely absent from the
 * toggles. A hand-edited `?by=user` is the case that would otherwise walk past a markup-level
 * omission, so it is named explicitly rather than covered by a generic "unknown value" case.
 */

describe('the fleet groupings', () => {
  it('offers a client, a workspace and a profile — and no person (FR-156)', () => {
    expect([...FLEET_SPEND_GROUPINGS]).toStrictEqual(['client', 'workspace', 'profile'])
    expect(FLEET_SPEND_GROUPINGS).not.toContain('user')
  })

  it('defaults to a collective grouping', () => {
    expect(FLEET_SPEND_GROUPINGS).toContain(DEFAULT_FLEET_GROUPING)
  })

  it('names every grouping it offers', () => {
    for (const grouping of FLEET_SPEND_GROUPINGS) {
      expect(GROUPING_LABELS[grouping].length).toBeGreaterThan(0)
    }
  })
})

describe('recognising a grouping', () => {
  it('accepts the three this screen shows', () => {
    for (const grouping of FLEET_SPEND_GROUPINGS) {
      expect(isFleetGrouping(grouping)).toBe(true)
    }
  })

  it('rejects the individual grouping and anything else', () => {
    for (const value of ['user', 'owner', '', undefined, 42, null]) {
      expect(isFleetGrouping(value)).toBe(false)
    }
  })
})

describe('parsing the grouping out of a URL', () => {
  it('reads a grouping the screen offers', () => {
    // Non-vacuous first: the parser has to actually work, or every fallback below is trivial.
    expect(parseSpendGrouping('client')).toBe('client')
    expect(parseSpendGrouping('workspace')).toBe('workspace')
  })

  it('falls back for a hand-edited `?by=user`, so the URL cannot rank individuals', () => {
    expect(parseSpendGrouping('user')).toBe(DEFAULT_FLEET_GROUPING)
    expect(parseSpendGrouping('user')).not.toBe('user')
  })

  it('falls back for an absent, empty or invented value', () => {
    for (const value of [undefined, '', 'nonsense', []]) {
      expect(parseSpendGrouping(value)).toBe(DEFAULT_FLEET_GROUPING)
    }
  })

  it('takes the first value when the key repeats, and still refuses `user`', () => {
    expect(parseSpendGrouping(['client', 'workspace'])).toBe('client')
    expect(parseSpendGrouping(['user', 'client'])).toBe(DEFAULT_FLEET_GROUPING)
  })
})

describe('the procedure input', () => {
  it('carries the grouping and nothing else', () => {
    expect(toSpendSummaryInput('workspace')).toStrictEqual({ groupBy: 'workspace' })
  })
})
