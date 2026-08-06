/* cspell:words issuetype */
import type { CandidateItem, IntegrationMapping } from '@bluetel-ai/sisyphus-api/contracts'
import { describe, expect, it } from 'vitest'

import { resolveProfile } from './resolve-profile'

const ticket = (attributes: CandidateItem['attributes']): CandidateItem => ({
  externalId: 'SIS-1',
  title: 'Fix the thing',
  url: 'https://example.atlassian.net/browse/SIS-1',
  body: null,
  assigneeEmail: null,
  comments: [],
  attributes,
})

const mapping = (overrides: Partial<IntegrationMapping>): IntegrationMapping => ({
  id: 'mapping-1',
  position: 0,
  criteria: {},
  executionProfileId: 'profile-1',
  isDefault: false,
  ...overrides,
})

describe('resolveProfile', () => {
  it('takes the first match by position, not by the order it was handed the rules', () => {
    const item = ticket({ components: ['api'], issuetype: 'Bug' })

    const resolution = resolveProfile(item, [
      mapping({
        id: 'third',
        position: 2,
        criteria: { components: 'api' },
        executionProfileId: 'c',
      }),
      mapping({
        id: 'first',
        position: 0,
        criteria: { issuetype: 'Task' },
        executionProfileId: 'a',
      }),
      mapping({
        id: 'second',
        position: 1,
        criteria: { components: 'api' },
        executionProfileId: 'b',
      }),
    ])

    expect(resolution).toEqual({ matched: true, executionProfileId: 'b', mappingId: 'second' })
  })

  it('records a skip when nothing matches, and never names a profile', () => {
    // The failure this prevents: one client's ticket run against another client's repository,
    // bundle and cap (FR-130).
    const resolution = resolveProfile(ticket({ components: ['mobile'] }), [
      mapping({ id: 'a', position: 0, criteria: { components: 'api' } }),
      mapping({ id: 'b', position: 1, criteria: { components: 'web' } }),
    ])

    expect(resolution.matched).toBe(false)
    expect(resolution).not.toHaveProperty('executionProfileId')
    if (resolution.matched) return
    expect(resolution.reason).toContain('guessed')
  })

  it('does not fall back to the only mapping there is', () => {
    const resolution = resolveProfile(ticket({ components: ['mobile'] }), [
      mapping({ criteria: { components: 'api' } }),
    ])

    expect(resolution.matched).toBe(false)
  })

  it('does not fall back to a mapping just because it is first', () => {
    const resolution = resolveProfile(ticket({}), [mapping({ criteria: { status: 'Ready' } })])

    expect(resolution.matched).toBe(false)
  })

  it('says so when the integration has no mappings at all', () => {
    const resolution = resolveProfile(ticket({}), [])

    expect(resolution.matched).toBe(false)
  })

  it('matches a declared default once it is reached', () => {
    const resolution = resolveProfile(ticket({ components: ['mobile'] }), [
      mapping({ id: 'specific', position: 0, criteria: { components: 'api' } }),
      mapping({ id: 'catch-all', position: 1, isDefault: true, executionProfileId: 'fallback' }),
    ])

    expect(resolution).toEqual({
      matched: true,
      executionProfileId: 'fallback',
      mappingId: 'catch-all',
    })
  })

  it('still honours position when a default is not last', () => {
    const resolution = resolveProfile(ticket({ components: ['api'] }), [
      mapping({ id: 'catch-all', position: 0, isDefault: true, executionProfileId: 'fallback' }),
      mapping({ id: 'specific', position: 1, criteria: { components: 'api' } }),
    ])

    // Deterministic, and a useful surprise: a default that is not last makes everything after it
    // unreachable, which the panel can point out because this is predictable.
    expect(resolution).toEqual({
      matched: true,
      executionProfileId: 'fallback',
      mappingId: 'catch-all',
    })
  })

  it('refuses to resolve when two mappings share a position', () => {
    const resolution = resolveProfile(ticket({ components: ['api'] }), [
      mapping({ id: 'a', position: 1, criteria: { components: 'api' }, executionProfileId: 'a' }),
      mapping({ id: 'b', position: 1, criteria: { components: 'api' }, executionProfileId: 'b' }),
    ])

    // Which profile the ticket got would otherwise depend on row order, and FR-131 would have no
    // honest answer for why the run had the settings it did.
    expect(resolution.matched).toBe(false)
    if (resolution.matched) return
    expect(resolution.reason).toContain('row order')
  })

  it('requires every criterion on a mapping, not just one of them', () => {
    const resolution = resolveProfile(ticket({ components: ['api'], issuetype: 'Task' }), [
      mapping({ criteria: { components: 'api', issuetype: 'Bug' } }),
    ])

    expect(resolution.matched).toBe(false)
  })

  it('matches a multi-valued attribute by membership', () => {
    const resolution = resolveProfile(ticket({ components: ['web', 'api'] }), [
      mapping({ criteria: { components: 'api' } }),
    ])

    expect(resolution.matched).toBe(true)
  })

  it('accepts a set of acceptable values for one criterion', () => {
    const resolution = resolveProfile(ticket({ status: 'Ready' }), [
      mapping({ criteria: { status: ['To Do', 'Ready'] } }),
    ])

    expect(resolution.matched).toBe(true)
  })

  it('ignores case and surrounding space, since "Bug" and "bug" are one issue type', () => {
    const resolution = resolveProfile(ticket({ issuetype: ' Bug ' }), [
      mapping({ criteria: { issuetype: 'bug' } }),
    ])

    expect(resolution.matched).toBe(true)
  })

  it('stops rather than falling through when a criterion cannot be evaluated', () => {
    // Falling through would hand the ticket to a later mapping that was never written to catch
    // it — a guess with a rule's paperwork.
    const resolution = resolveProfile(ticket({ components: ['api'] }), [
      mapping({ id: 'broken', position: 0, criteria: { components: { in: ['api'] } } }),
      mapping({ id: 'later', position: 1, criteria: { components: 'api' } }),
    ])

    expect(resolution.matched).toBe(false)
    if (resolution.matched) return
    expect(resolution.reason).toContain('position 0')
  })

  it('is deterministic: the same ticket and rules resolve the same way every time', () => {
    const item = ticket({ components: ['api'], status: 'Ready' })
    const mappings = [
      mapping({ id: 'a', position: 0, criteria: { status: 'Blocked' } }),
      mapping({ id: 'b', position: 1, criteria: { components: 'api' } }),
    ]

    const first = resolveProfile(item, mappings)
    const second = resolveProfile(item, [...mappings].reverse())

    expect(first).toEqual(second)
  })

  it('does not mutate the mappings it was given', () => {
    const mappings = [mapping({ id: 'b', position: 1 }), mapping({ id: 'a', position: 0 })]

    resolveProfile(ticket({}), mappings)

    expect(mappings.map((entry) => entry.id)).toEqual(['b', 'a'])
  })
})
