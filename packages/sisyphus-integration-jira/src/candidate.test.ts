/* cspell:words issuetype */
import { describe, expect, it } from 'vitest'

import { toCandidateItem, UNUSABLE_ISSUE } from './candidate'
import type { JiraIssue } from './client'

const platform = { accountId: 'bot-account' }
const context = { baseUrl: 'https://example.atlassian.net/', platform }

const issue = (overrides: Partial<JiraIssue> = {}): JiraIssue => ({
  id: '10001',
  key: 'SIS-1',
  fields: { summary: 'Fix the thing', description: 'It is broken' },
  ...overrides,
})

const unwrap = (result: ReturnType<typeof toCandidateItem>) => {
  if (!result.ok) {
    throw new Error(`expected a candidate, got a skip: ${result.skip.reason}`)
  }
  return result.item
}

describe('toCandidateItem', () => {
  it('takes the issue key as the external id, since that is the claim key', () => {
    expect(unwrap(toCandidateItem(issue(), context)).externalId).toBe('SIS-1')
  })

  it('builds the browse URL without doubling the slash', () => {
    expect(unwrap(toCandidateItem(issue(), context)).url).toBe(
      'https://example.atlassian.net/browse/SIS-1',
    )
  })

  it('declines an issue with no key, and says why', () => {
    // Nothing can be done with it: it cannot be claimed (FR-102) and cannot be commented on.
    const result = toCandidateItem({ id: '10002' }, context)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.skip.reason).toBe(UNUSABLE_ISSUE)
    expect(result.skip.detail).toContain('10002')
  })

  it('keeps ticket content out of the skip detail', () => {
    const result = toCandidateItem(
      { id: '10002', fields: { summary: 'Customer name and password reset' } },
      context,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.skip.detail).not.toContain('Customer name')
  })

  it('still produces a candidate for an empty ticket, so FR-164 can skip and comment on it', () => {
    // An empty ticket is a real ticket somebody labelled without describing. The control plane
    // has to be able to comment on it, which means it needs the key and the URL.
    const item = unwrap(
      toCandidateItem(issue({ fields: { summary: '', description: '   ' } }), context),
    )

    expect(item.title).toBe('')
    expect(item.body).toBeNull()
    expect(item.externalId).toBe('SIS-1')
  })

  it('survives an issue with no fields at all', () => {
    const item = unwrap(toCandidateItem({ key: 'SIS-9' }, context))

    expect(item.title).toBe('')
    expect(item.comments).toEqual([])
    expect(item.attributes).toEqual({})
    expect(item.assigneeEmail).toBeNull()
  })

  it('exposes components and labels as lists rather than a joined string', () => {
    const item = unwrap(
      toCandidateItem(
        issue({
          fields: {
            summary: 'x',
            project: { key: 'SIS' },
            issuetype: { name: 'Bug' },
            status: { name: 'Ready' },
            components: [{ name: 'api' }, { name: 'web' }, {}],
            labels: ['sisyphus', 'urgent'],
          },
        }),
        context,
      ),
    )

    expect(item.attributes).toEqual({
      project: 'SIS',
      issuetype: 'Bug',
      status: 'Ready',
      components: ['api', 'web'],
      labels: ['sisyphus', 'urgent'],
    })
  })

  it('marks the platform’s own comments by identity as it maps them', () => {
    const item = unwrap(
      toCandidateItem(
        issue({
          fields: {
            summary: 'x',
            comment: {
              comments: [
                { id: '1', author: { accountId: 'human' }, body: 'please fix' },
                { id: '2', author: { accountId: 'bot-account' }, body: 'Sisyphus picked this up' },
              ],
            },
          },
        }),
        context,
      ),
    )

    expect(item.comments.map((comment) => comment.isPlatformAuthored)).toEqual([false, true])
    expect(item.comments.map((comment) => comment.authorIdentity)).toEqual(['human', 'bot-account'])
  })

  it('treats an unattributable comment as human', () => {
    const item = unwrap(
      toCandidateItem(
        issue({ fields: { summary: 'x', comment: { comments: [{ id: '1', body: 'hi' }] } } }),
        context,
      ),
    )

    expect(item.comments[0]?.isPlatformAuthored).toBe(false)
    expect(item.comments[0]?.authorIdentity).toBe('unknown')
  })

  it('orders comments oldest first, whatever order Jira returned them in', () => {
    const item = unwrap(
      toCandidateItem(
        issue({
          fields: {
            summary: 'x',
            comment: {
              comments: [
                { id: 'newer', body: 'second', created: '2026-02-01T00:00:00.000Z' },
                { id: 'older', body: 'first', created: '2026-01-01T00:00:00.000Z' },
              ],
            },
          },
        }),
        context,
      ),
    )

    expect(item.comments.map((comment) => comment.id)).toEqual(['older', 'newer'])
  })

  it('keeps Jira’s order when a timestamp will not parse', () => {
    const item = unwrap(
      toCandidateItem(
        issue({
          fields: {
            summary: 'x',
            comment: {
              comments: [
                { id: 'a', body: 'first', created: 'not a date' },
                { id: 'b', body: 'second', created: '2026-01-01T00:00:00.000Z' },
              ],
            },
          },
        }),
        context,
      ),
    )

    expect(item.comments.map((comment) => comment.id)).toEqual(['a', 'b'])
  })

  it('surfaces the assignee email for the control plane to resolve an owner', () => {
    const item = unwrap(
      toCandidateItem(
        issue({ fields: { summary: 'x', assignee: { emailAddress: 'dev@bluetel.co.uk' } } }),
        context,
      ),
    )

    expect(item.assigneeEmail).toBe('dev@bluetel.co.uk')
  })
})
