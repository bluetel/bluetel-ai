import { describe, expect, it } from 'vitest'

import {
  EMPTY_FILTERS,
  hasActiveFilters,
  ID_FILTER_KEYS,
  ID_FILTER_NAMES,
  invalidIdFilters,
  parseWorkflowFilters,
  toListInput,
  toSearchParams,
  WORKFLOW_PAGE_SIZE,
} from './workflow-filters'

/**
 * The three representations a filter set moves between — a URL, a form draft and a procedure's
 * input — and the properties that have to hold across them.
 *
 * The round trip is the assertion that matters most: a filter that serialises to a key the parser
 * does not read silently resets on reload, and nothing else in the suite would notice.
 */

const UUID = '0199a1f4-0000-7000-8000-000000000001'
const OTHER_UUID = '0199a1f4-0000-7000-8000-000000000002'

describe('parseWorkflowFilters', () => {
  it('reads every filter the bar can set', () => {
    const filters = parseWorkflowFilters({
      q: 'ABC-12',
      state: ['running', 'failed'],
      type: 'delegated',
      repo: 'https://git.test/acme/api',
      user: UUID,
      integration: OTHER_UUID,
      profile: UUID,
      workspace: OTHER_UUID,
      bundle: UUID,
    })

    expect(filters).toStrictEqual({
      search: 'ABC-12',
      states: ['running', 'failed'],
      type: 'delegated',
      repositoryUrl: 'https://git.test/acme/api',
      initiatedByUserId: UUID,
      originatingIntegrationId: OTHER_UUID,
      executionProfileId: UUID,
      workspaceId: OTHER_UUID,
      setupBundleId: UUID,
    })
  })

  it('reads a repeated state key as several states rather than as one', () => {
    expect(parseWorkflowFilters({ state: ['queued', 'paused'] }).states).toStrictEqual([
      'queued',
      'paused',
    ])
    expect(parseWorkflowFilters({ state: 'queued' }).states).toStrictEqual(['queued'])
  })

  it('drops a state a hand-edited URL invented, so a stale link lists rather than errors', () => {
    expect(parseWorkflowFilters({ state: ['running', 'deleted'] }).states).toStrictEqual([
      'running',
    ])
  })

  it('drops an unknown type for the same reason', () => {
    expect(parseWorkflowFilters({ type: 'supervised' }).type).toBeUndefined()
  })

  it('answers the empty filter set for an empty query string', () => {
    expect(parseWorkflowFilters({})).toStrictEqual(EMPTY_FILTERS)
  })

  it('trims, so a URL with a stray space does not filter on one', () => {
    expect(parseWorkflowFilters({ q: '  ABC-12 ' }).search).toBe('ABC-12')
  })
})

describe('toSearchParams', () => {
  it('contributes no key for an unset filter', () => {
    expect(toSearchParams(EMPTY_FILTERS)).toBe('')
  })

  it('round-trips every filter through the URL unchanged', () => {
    const filters = {
      search: 'ABC-12',
      states: ['running', 'failed'],
      type: 'delegated',
      repositoryUrl: 'https://git.test/acme/api',
      initiatedByUserId: UUID,
      originatingIntegrationId: OTHER_UUID,
      executionProfileId: UUID,
      workspaceId: OTHER_UUID,
      setupBundleId: UUID,
    } as const

    const query = toSearchParams(filters)

    expect(parseWorkflowFilters(Object.fromEntries(new URLSearchParams(query)))).toMatchObject({
      search: 'ABC-12',
      type: 'delegated',
      repositoryUrl: 'https://git.test/acme/api',
      initiatedByUserId: UUID,
    })
    // `Object.fromEntries` keeps one value per key, so the repeated state key is checked directly.
    expect(new URLSearchParams(query).getAll('state')).toStrictEqual(['running', 'failed'])
  })

  it('uses the short key each id filter is declared under', () => {
    for (const name of ID_FILTER_NAMES) {
      const query = toSearchParams({ ...EMPTY_FILTERS, [name]: UUID })
      expect(query).toBe(`${ID_FILTER_KEYS[name]}=${UUID}`)
    }
  })
})

describe('invalidIdFilters', () => {
  it('accepts an empty field — absent is not invalid', () => {
    expect(invalidIdFilters(EMPTY_FILTERS)).toStrictEqual([])
  })

  it('accepts an identifier', () => {
    expect(invalidIdFilters({ ...EMPTY_FILTERS, workspaceId: UUID })).toStrictEqual([])
  })

  it('names the field holding something that is not an identifier', () => {
    expect(invalidIdFilters({ ...EMPTY_FILTERS, executionProfileId: 'the api one' })).toStrictEqual(
      ['executionProfileId'],
    )
  })

  it('names every offending field, so a form marks all of them at once', () => {
    expect(
      invalidIdFilters({ ...EMPTY_FILTERS, workspaceId: 'x', setupBundleId: 'y' }),
    ).toStrictEqual(['workspaceId', 'setupBundleId'])
  })
})

describe('toListInput', () => {
  it('asks for one bounded page and nothing else when nothing is narrowed', () => {
    expect(toListInput(EMPTY_FILTERS)).toStrictEqual({ limit: WORKFLOW_PAGE_SIZE })
  })

  it('omits an empty state array, which the schema would refuse', () => {
    expect('state' in toListInput(EMPTY_FILTERS)).toBe(false)
  })

  it('carries no cursor — paging is the infinite query’s job, not the filters’', () => {
    expect('cursor' in toListInput({ ...EMPTY_FILTERS, search: 'ABC-12' })).toBe(false)
  })

  it('sends every set filter, trimmed', () => {
    expect(
      toListInput({
        search: ' ABC-12 ',
        states: ['failed'],
        type: 'review',
        repositoryUrl: ' https://git.test/acme/api ',
        initiatedByUserId: UUID,
        originatingIntegrationId: '',
        executionProfileId: '',
        workspaceId: '',
        setupBundleId: '',
      }),
    ).toStrictEqual({
      limit: WORKFLOW_PAGE_SIZE,
      search: 'ABC-12',
      state: ['failed'],
      type: 'review',
      repositoryUrl: 'https://git.test/acme/api',
      initiatedByUserId: UUID,
    })
  })

  it('honours an explicit page size', () => {
    expect(toListInput(EMPTY_FILTERS, 10).limit).toBe(10)
  })
})

describe('hasActiveFilters', () => {
  it('is false when nothing is narrowed', () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false)
  })

  it('is true for a whitespace-only search, because trimming makes it nothing', () => {
    expect(hasActiveFilters({ ...EMPTY_FILTERS, search: '   ' })).toBe(false)
  })

  it('is true once any filter is set', () => {
    expect(hasActiveFilters({ ...EMPTY_FILTERS, states: ['queued'] })).toBe(true)
  })
})
