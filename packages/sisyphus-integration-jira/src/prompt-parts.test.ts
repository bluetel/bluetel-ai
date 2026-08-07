import type { CandidateItem, ItemComment } from '@bluetel-ai/sisyphus-api/contracts'
import { describe, expect, it } from 'vitest'

import { toCandidateItem } from './candidate'
import type { JiraCommentRecord } from './client'
import { commentKey, renderCommentBody } from './comment-body'
import { assemblePromptParts, DEFAULT_MAX_COMMENTS } from './prompt-parts'

const PLATFORM = { accountId: 'sisyphus-service-account' }
const HUMAN = { accountId: 'harry', emailAddress: 'ht@bluetel.co.uk' }

const ticketWith = (comments: readonly JiraCommentRecord[]): CandidateItem => {
  const result = toCandidateItem(
    {
      id: '1',
      key: 'SIS-1',
      fields: { summary: 'Fix the thing', description: 'It is broken', comment: { comments } },
    },
    { baseUrl: 'https://example.atlassian.net', platform: PLATFORM },
  )

  if (!result.ok) {
    throw new Error('expected a candidate')
  }

  return result.item
}

const comment = (overrides: Partial<ItemComment>): ItemComment => ({
  id: 'c-1',
  authorIdentity: 'harry',
  isPlatformAuthored: false,
  body: 'a comment',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
})

const itemWith = (comments: readonly ItemComment[]): CandidateItem => ({
  externalId: 'SIS-1',
  title: 'Fix the thing',
  url: 'https://example.atlassian.net/browse/SIS-1',
  body: 'It is broken',
  assigneeEmail: null,
  comments,
  attributes: {},
})

describe('assemblePromptParts — the exclusion (FR-161)', () => {
  it('is decided by authorship, not by what the comment says', () => {
    // The ticket that only an identity rule gets right. Both comments are chosen so that a rule
    // matching on text — "starts with Sisyphus", "contains the marker", any of them — gets both
    // of them wrong, in opposite directions.
    const platformPickup = renderCommentBody(
      { kind: 'picked_up', workflowId: 'wf-1', workflowUrl: 'https://sisyphus.example/w/wf-1' },
      commentKey(itemWith([]), {
        kind: 'picked_up',
        workflowId: 'wf-1',
        workflowUrl: 'https://sisyphus.example/w/wf-1',
      }),
    )

    const item = ticketWith([
      {
        id: 'human-quoting-sisyphus',
        author: HUMAN,
        // A human quoting the platform's comment back, marker and all, to ask about it. People
        // do this constantly, and it is task input.
        body: `${platformPickup}\n\nWhy did this get picked up? Please only touch the API.`,
        created: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'platform-sounding-human',
        author: PLATFORM,
        // The platform's own comment, in wording no pattern would catch.
        body: 'Looked at this and opened a change for review.',
        created: '2026-01-02T00:00:00.000Z',
      },
    ])

    const parts = assemblePromptParts(item, {})

    expect(parts.comments).toHaveLength(1)
    expect(parts.comments[0]).toContain('Please only touch the API.')
    // A text rule would have dropped the human's comment — losing the one instruction on the
    // ticket — and kept the platform's, reopening the loop it was written to close.
    expect(parts.comments[0]).toContain('Why did this get picked up?')
    expect(parts.comments.join('\n')).not.toContain('opened a change for review')
  })

  it('is a fixed point: a second run reads the same task input as the first', () => {
    // The compounding failure, played out. Run one assembles from a ticket, then writes back;
    // run two assembles from the ticket that now carries that write-back.
    const humanComments: JiraCommentRecord[] = [
      {
        id: 'c1',
        author: HUMAN,
        body: 'The retry loop double-posts.',
        created: '2026-01-01T00:00:00.000Z',
      },
    ]

    const firstRun = assemblePromptParts(ticketWith(humanComments), {})

    const afterWriteBack: JiraCommentRecord[] = [
      ...humanComments,
      {
        id: 'c2',
        author: PLATFORM,
        body: renderCommentBody(
          { kind: 'picked_up', workflowId: 'wf-1', workflowUrl: 'https://sisyphus.example/w/wf-1' },
          'jira-comment:wf-1:SIS-1:picked_up',
        ),
        created: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'c3',
        author: PLATFORM,
        body: renderCommentBody(
          {
            kind: 'outcome',
            workflowId: 'wf-1',
            outcome: 'completed',
            pullRequestUrls: ['https://github.com/acme/api/pull/1'],
          },
          'jira-comment:wf-1:SIS-1:outcome',
        ),
        created: '2026-01-03T00:00:00.000Z',
      },
    ]

    const secondRun = assemblePromptParts(ticketWith(afterWriteBack), {})

    expect(secondRun).toEqual(firstRun)
    expect(secondRun.comments.join('\n')).not.toContain('Sisyphus has picked this ticket up')
    expect(secondRun.comments.join('\n')).not.toContain('github.com/acme/api/pull/1')
  })

  it('keeps a human comment that is byte-identical to a platform comment', () => {
    const body = renderCommentBody(
      { kind: 'outcome', workflowId: 'wf-1', outcome: 'completed', pullRequestUrls: [] },
      'jira-comment:wf-1:SIS-1:outcome',
    )

    const item = ticketWith([
      { id: 'c1', author: HUMAN, body, created: '2026-01-01T00:00:00.000Z' },
    ])

    expect(assemblePromptParts(item, {}).comments).toEqual([body])
  })

  it('does not count an excluded comment as truncation', () => {
    const item = itemWith([
      comment({ id: 'a', body: 'human' }),
      comment({ id: 'b', body: 'platform', isPlatformAuthored: true }),
    ])

    // Nothing was lost to a bound: the platform's comment was never task input.
    expect(assemblePromptParts(item, {}).truncatedComments).toBe(0)
  })
})

describe('assemblePromptParts — the parts (FR-159)', () => {
  it('carries the title, URL and description unchanged', () => {
    const parts = assemblePromptParts(itemWith([]), {})

    expect(parts.title).toBe('Fix the thing')
    expect(parts.url).toBe('https://example.atlassian.net/browse/SIS-1')
    expect(parts.body).toBe('It is broken')
  })

  it('keeps comments oldest first', () => {
    const item = itemWith([
      comment({ id: 'a', body: 'first', createdAt: new Date('2026-01-01T00:00:00.000Z') }),
      comment({ id: 'b', body: 'second', createdAt: new Date('2026-01-02T00:00:00.000Z') }),
    ])

    expect(assemblePromptParts(item, {}).comments).toEqual(['first', 'second'])
  })

  it('drops an empty comment without calling it truncation', () => {
    const item = itemWith([comment({ id: 'a', body: '   ' }), comment({ id: 'b', body: 'real' })])
    const parts = assemblePromptParts(item, {})

    expect(parts.comments).toEqual(['real'])
    expect(parts.truncatedComments).toBe(0)
  })

  it('carries a ticket with no description as a null body rather than an empty string', () => {
    const parts = assemblePromptParts({ ...itemWith([]), body: null }, {})

    expect(parts.body).toBeNull()
  })
})

describe('assemblePromptParts — the bound (FR-163)', () => {
  it('drops comments oldest first and reports how many', () => {
    const item = itemWith([
      comment({ id: 'a', body: 'a'.repeat(10) }),
      comment({ id: 'b', body: 'b'.repeat(10) }),
      comment({ id: 'c', body: 'c'.repeat(10) }),
    ])

    const parts = assemblePromptParts(item, { maxCommentCharacters: 20 })

    expect(parts.comments).toEqual(['b'.repeat(10), 'c'.repeat(10)])
    expect(parts.truncatedComments).toBe(1)
  })

  it('never truncates the title, URL or description away to make room', () => {
    const item = { ...itemWith([comment({ body: 'x'.repeat(100) })]), body: 'y'.repeat(100) }

    const parts = assemblePromptParts(item, { maxCommentCharacters: 0 })

    expect(parts.title).toBe('Fix the thing')
    expect(parts.url).toBe('https://example.atlassian.net/browse/SIS-1')
    expect(parts.body).toBe('y'.repeat(100))
    expect(parts.comments).toEqual([])
    expect(parts.truncatedComments).toBe(1)
  })

  it('drops a single comment that is larger than the whole budget', () => {
    const item = itemWith([comment({ body: 'x'.repeat(50) })])

    const parts = assemblePromptParts(item, { maxCommentCharacters: 10 })

    expect(parts.comments).toEqual([])
    expect(parts.truncatedComments).toBe(1)
  })

  it('caps the count as well as the size', () => {
    const item = itemWith(
      Array.from({ length: DEFAULT_MAX_COMMENTS + 5 }, (_unused, index) =>
        comment({ id: String(index), body: `comment ${String(index)}` }),
      ),
    )

    const parts = assemblePromptParts(item, {})

    expect(parts.comments).toHaveLength(DEFAULT_MAX_COMMENTS)
    expect(parts.truncatedComments).toBe(5)
    // The newest survive: they are the ones most likely to matter.
    expect(parts.comments.at(-1)).toBe(`comment ${String(DEFAULT_MAX_COMMENTS + 4)}`)
  })

  it('is unchanged by an empty context', () => {
    const item = itemWith([comment({ body: 'one' })])

    expect(assemblePromptParts(item, {}).comments).toEqual(['one'])
  })
})
