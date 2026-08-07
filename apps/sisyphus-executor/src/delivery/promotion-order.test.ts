import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import type { OrderableEntry } from './promotion-order'
import { PROMOTION_SKILL_NAME, promotionOrderError, requirePromotionOrder } from './promotion-order'

/**
 * FR-117 — the integration order is the client's, stated in their
 * `sisyphus-integration` skill, and never Sisyphus's.
 *
 * The tests that matter here are the ones that would pass just as happily
 * against a module with a built-in default, so each of them is written to fail
 * if one existed: two clients declaring *different* orders over the same
 * workspace both get what they declared, neither of them is the workspace's own
 * declaration order, and a workspace with no declaration gets no order at all.
 */

const entries: readonly OrderableEntry[] = [
  { entryId: 'api' },
  { entryId: 'web' },
  { entryId: 'shared' },
]

const step = 'integrate'

const positionsOf = (declared: readonly string[]): readonly string[] =>
  requirePromotionOrder({ entryIds: declared }, { entries, step }).map(({ entry }) => entry.entryId)

describe('requirePromotionOrder', () => {
  it('places the entries exactly as the skill declared them', () => {
    expect(positionsOf(['shared', 'api', 'web'])).toEqual(['shared', 'api', 'web'])
  })

  it('gives a different client a different order over the same workspace (FR-117)', () => {
    // The pair is the whole point: no single ordering rule can produce both, so
    // nothing but the declaration can be deciding this.
    expect(positionsOf(['shared', 'api', 'web'])).toEqual(['shared', 'api', 'web'])
    expect(positionsOf(['web', 'shared', 'api'])).toEqual(['web', 'shared', 'api'])
  })

  it('does not fall back to the workspace’s own declaration order', () => {
    const declared = positionsOf(['shared', 'web', 'api'])

    expect(declared).not.toEqual(entries.map(({ entryId }) => entryId))
  })

  it('does not put the primary first, or anywhere in particular', () => {
    // `api` is the primary in every other test in this suite; the skill is free
    // to integrate it last, and nothing here objects.
    expect(positionsOf(['web', 'shared', 'api']).at(-1)).toBe('api')
  })

  it('numbers the steps from one, so a halt can say which is second', () => {
    expect(
      requirePromotionOrder({ entryIds: ['web', 'api', 'shared'] }, { entries, step }),
    ).toEqual([
      { entry: { entryId: 'web' }, position: 1 },
      { entry: { entryId: 'api' }, position: 2 },
      { entry: { entryId: 'shared' }, position: 3 },
    ])
  })

  it('carries the caller’s own entry shape through, not a reduced one', () => {
    const rich = [
      { entryId: 'api', repository: 'https://git.test/acme/api' },
      { entryId: 'web', repository: 'https://git.test/acme/web' },
    ]

    const ordered = requirePromotionOrder({ entryIds: ['web', 'api'] }, { entries: rich, step })

    expect(ordered.map(({ entry }) => entry.repository)).toEqual([
      'https://git.test/acme/web',
      'https://git.test/acme/api',
    ])
  })
})

describe('a declaration this module refuses to complete', () => {
  it('halts when several repositories are given no order (FR-117, FR-058)', () => {
    expect(() => requirePromotionOrder(undefined, { entries, step })).toThrow(
      /states no order for them/,
    )
  })

  it('names the skill and the step in the halt (FR-058)', () => {
    expect(() => requirePromotionOrder({ entryIds: [] }, { entries, step })).toThrow(
      new RegExp(`${PROMOTION_SKILL_NAME}.+${step} step`),
    )
  })

  it('refuses an order naming a repository the workspace does not contain', () => {
    expect(() =>
      requirePromotionOrder({ entryIds: ['api', 'web', 'shared', 'infra'] }, { entries, step }),
    ).toThrow(/"infra", which is not an entry of this workspace/)
  })

  it('refuses an order that leaves a repository unplaced, rather than appending it', () => {
    expect(() => requirePromotionOrder({ entryIds: ['api', 'web'] }, { entries, step })).toThrow(
      /does not place "shared"/,
    )
  })

  it('refuses a repeated repository, whose position is ambiguous', () => {
    expect(() =>
      requirePromotionOrder({ entryIds: ['api', 'api', 'web', 'shared'] }, { entries, step }),
    ).toThrow(/more than once/)
  })

  it('reports every problem at once, so one fix does not reveal the next', () => {
    const failure = (): unknown =>
      requirePromotionOrder({ entryIds: ['api', 'infra'] }, { entries, step })

    expect(failure).toThrow(/not an entry of this workspace/)
    expect(failure).toThrow(/does not place/)
  })

  it('refuses an empty workspace instead of answering with an empty order', () => {
    expect(() => requirePromotionOrder({ entryIds: [] }, { entries: [], step })).toThrow(
      /no entries to order/,
    )
  })

  it('suggests no order on the way out', () => {
    const message = promotionOrderError(step, ['nothing was declared']).message

    for (const entryId of ['api', 'web', 'shared']) {
      expect(message).not.toContain(entryId)
    }
  })
})

describe('the single-entry workspace', () => {
  it('needs no declaration, because there is nothing to choose (FR-109)', () => {
    expect(requirePromotionOrder(undefined, { entries: [{ entryId: 'api' }], step })).toEqual([
      { entry: { entryId: 'api' }, position: 1 },
    ])
  })

  it('still honours a declaration when the skill makes one', () => {
    expect(
      requirePromotionOrder({ entryIds: ['api'] }, { entries: [{ entryId: 'api' }], step }),
    ).toEqual([{ entry: { entryId: 'api' }, position: 1 }])
  })
})

describe('the module itself', () => {
  it('contains no ordering of its own', async () => {
    const source = await readFile(new URL('promotion-order.ts', import.meta.url), 'utf8')

    // A guard against the default that gets added later "just for the simple
    // case". Nothing in here may sort, reverse, or prefer the primary.
    expect(source).not.toMatch(/\.sort\(/)
    expect(source).not.toMatch(/\.reverse\(/)
    expect(source).not.toMatch(/isPrimary/)
    expect(source).not.toMatch(/DEFAULT_(ORDER|PROMOTION)/)
  })
})
