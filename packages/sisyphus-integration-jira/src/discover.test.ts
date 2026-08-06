/* cspell:words issuekey */
import type { DiscoverySkip } from '@bluetel-ai/sisyphus-api/contracts'
import { describe, expect, it } from 'vitest'

import { UNUSABLE_ISSUE } from './candidate'
import type { JiraIssue } from './client'
import { createFakeJiraClient } from './client-fake'
import { resolveJiraConfig } from './config'
import { DISCOVERY_TRUNCATED, discover } from './discover'

const config = (overrides: Record<string, unknown> = {}) =>
  resolveJiraConfig({
    baseUrl: 'https://example.atlassian.net',
    projectPrefix: 'SIS',
    label: 'sisyphus',
    ...overrides,
  })

const issue = (key: string): JiraIssue => ({ id: key, key, fields: { summary: key } })

const issues = (count: number): JiraIssue[] =>
  Array.from({ length: count }, (_unused, index) => issue(`SIS-${String(index + 1)}`))

const collector = () => {
  const skips: DiscoverySkip[] = []
  return {
    skips,
    ctx: {
      recordSkip: (skip: DiscoverySkip) => {
        skips.push(skip)
      },
    },
  }
}

const platformUser = { accountId: 'bot-account' }

describe('discover', () => {
  it('pages until the board says there is no more', async () => {
    const client = createFakeJiraClient({ currentUser: platformUser, issues: issues(120) })

    const found = await discover(client, config(), {})

    expect(found).toHaveLength(120)
    expect(client.searches.map((search) => search.startAt)).toEqual([0, 50, 100])
    expect(client.searches.every((search) => search.maxResults <= 50)).toBe(true)
  })

  it('runs the scoped, ordered query rather than a bare search', async () => {
    const client = createFakeJiraClient({ currentUser: platformUser, issues: issues(1) })

    await discover(client, config(), {})

    expect(client.searches[0]?.jql).toBe(
      'project = "SIS" AND labels = "sisyphus" ORDER BY created ASC, issuekey ASC',
    )
  })

  it('advances by what it received, not by what it asked for', async () => {
    // A deployment may cap the page size below what was requested. Advancing by the request would
    // step over the tickets it did not send.
    const client = createFakeJiraClient({ currentUser: platformUser, issues: issues(7) })

    const found = await discover(client, config({ pageSize: 3 }), {})

    expect(found.map((item) => item.externalId)).toEqual([
      'SIS-1',
      'SIS-2',
      'SIS-3',
      'SIS-4',
      'SIS-5',
      'SIS-6',
      'SIS-7',
    ])
    expect(client.searches.map((search) => search.startAt)).toEqual([0, 3, 6])
  })

  it('stops at the per-tick maximum and records that it did', async () => {
    const client = createFakeJiraClient({ currentUser: platformUser, issues: issues(200) })
    const { ctx, skips } = collector()

    const found = await discover(client, config({ pageSize: 10, maxItemsPerTick: 25 }), ctx)

    expect(found).toHaveLength(25)
    expect(skips.map((skip) => skip.reason)).toEqual([DISCOVERY_TRUNCATED])
    // Nothing is lost: what it did not read is unclaimed, so it matches again next tick.
    expect(skips[0]?.detail).toContain('next tick')
  })

  it('records an issue it cannot use rather than dropping it silently', async () => {
    const client = createFakeJiraClient({
      currentUser: platformUser,
      issues: [issue('SIS-1'), { id: '99', fields: { summary: 'no key' } }],
    })
    const { ctx, skips } = collector()

    const found = await discover(client, config(), ctx)

    expect(found.map((item) => item.externalId)).toEqual(['SIS-1'])
    expect(skips.map((skip) => skip.reason)).toEqual([UNUSABLE_ISSUE])
  })

  it('carries an empty ticket as a candidate, for the control plane to skip and comment on', async () => {
    // FR-164 requires a comment on the ticket, which requires a candidate to comment on.
    const client = createFakeJiraClient({
      currentUser: platformUser,
      issues: [{ id: '1', key: 'SIS-1', fields: { summary: '', description: null } }],
    })

    const found = await discover(client, config(), {})

    expect(found).toHaveLength(1)
    expect(found[0]?.title).toBe('')
    expect(found[0]?.body).toBeNull()
  })

  it('carries a ticket once even if it appears on two pages', async () => {
    const client = createFakeJiraClient({
      currentUser: platformUser,
      issues: [issue('SIS-1'), issue('SIS-2'), issue('SIS-1'), issue('SIS-3')],
    })

    const found = await discover(client, config({ pageSize: 2 }), {})

    expect(found.map((item) => item.externalId)).toEqual(['SIS-1', 'SIS-2', 'SIS-3'])
  })

  it('does not narrow the query by the last run time', async () => {
    // A ticket deferred by a ceiling is never modified again, so an `updated >= since` filter
    // would drop it from every later tick and it would never run.
    const client = createFakeJiraClient({ currentUser: platformUser, issues: issues(1) })

    await discover(client, config(), { since: new Date('2026-01-01T00:00:00.000Z') })

    expect(client.searches[0]?.jql).not.toContain('updated')
  })

  it('starts nothing — it only reads', async () => {
    const client = createFakeJiraClient({ currentUser: platformUser, issues: issues(3) })

    await discover(client, config(), {})

    expect(client.posted).toEqual([])
  })

  it('marks the platform’s own comments while mapping, ready for prompt assembly', async () => {
    const client = createFakeJiraClient({
      currentUser: platformUser,
      issues: [
        {
          id: '1',
          key: 'SIS-1',
          fields: {
            summary: 'x',
            comment: {
              comments: [
                { id: 'a', author: { accountId: 'human' }, body: 'please' },
                { id: 'b', author: { accountId: 'bot-account' }, body: 'picked up' },
              ],
            },
          },
        },
      ],
    })

    const found = await discover(client, config(), {})

    expect(found[0]?.comments.map((comment) => comment.isPlatformAuthored)).toEqual([false, true])
  })

  it('refuses the tick when the platform identity cannot be established', async () => {
    const client = createFakeJiraClient({ currentUser: {}, issues: issues(1) })

    await expect(discover(client, config(), {})).rejects.toThrow(/cannot tell its own comments/)
    expect(client.searches).toEqual([])
  })

  it('propagates an unreachable deployment, for the run to be recorded as failed', async () => {
    // FR-108: a failed tick is recorded and retried; it must not look like a board with no work.
    const client = createFakeJiraClient({
      currentUser: platformUser,
      searchError: new Error('503 Service Unavailable'),
    })

    await expect(discover(client, config(), {})).rejects.toThrow('503')
  })

  it('returns nothing for a board with no matching tickets', async () => {
    const client = createFakeJiraClient({ currentUser: platformUser, issues: [] })

    await expect(discover(client, config(), {})).resolves.toEqual([])
  })
})
