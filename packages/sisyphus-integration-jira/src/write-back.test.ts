import type { CandidateItem, WriteBackEvent } from '@bluetel-ai/sisyphus-api/contracts'
import { describe, expect, it } from 'vitest'

import { createFakeJiraClient } from './client-fake'
import { commentKey, renderCommentBody, renderMarker } from './comment-body'
import { resolveJiraConfig } from './config'
import { writeBack } from './write-back'

const PLATFORM = { accountId: 'sisyphus-service-account' }

const config = (overrides: Record<string, unknown> = {}) =>
  resolveJiraConfig({
    baseUrl: 'https://example.atlassian.net',
    projectPrefix: 'SIS',
    label: 'sisyphus',
    serviceAccount: PLATFORM,
    ...overrides,
  })

const item: CandidateItem = {
  externalId: 'SIS-1',
  title: 'Fix the thing',
  url: 'https://example.atlassian.net/browse/SIS-1',
  body: null,
  assigneeEmail: null,
  comments: [],
  attributes: {},
}

const pickup: WriteBackEvent = {
  kind: 'picked_up',
  workflowId: 'wf-1',
  workflowUrl: 'https://sisyphus.example/w/wf-1',
}

const previousAttempt = (event: WriteBackEvent) => ({
  id: 'existing-comment',
  author: PLATFORM,
  body: renderCommentBody(event, commentKey(item, event)),
  created: '2026-01-01T00:00:00.000Z',
})

describe('writeBack', () => {
  it('posts the comment and reports having performed it', async () => {
    const client = createFakeJiraClient({ commentAuthor: PLATFORM })

    const result = await writeBack(client, config(), item, pickup)

    expect(result.disposition).toBe('performed')
    expect(result.key).toBe('jira-comment:wf-1:SIS-1:picked_up')
    expect(client.posted).toHaveLength(1)
    expect(client.posted[0]?.issueKey).toBe('SIS-1')
    expect(client.posted[0]?.idempotencyKey).toBe('jira-comment:wf-1:SIS-1:picked_up')
  })

  it('looks before it creates', async () => {
    const client = createFakeJiraClient({ commentAuthor: PLATFORM })

    await writeBack(client, config(), item, pickup)

    expect(client.commentReads).toContain('SIS-1')
  })

  it('does not post a second comment when the first one is already there', async () => {
    const client = createFakeJiraClient({
      commentAuthor: PLATFORM,
      comments: { 'SIS-1': [previousAttempt(pickup)] },
    })

    const result = await writeBack(client, config(), item, pickup)

    expect(result.disposition).toBe('already-performed')
    expect(result.reference).toBe('existing-comment')
    expect(client.posted).toEqual([])
  })

  it('reports success when the comment landed and the connection then died', async () => {
    // The case the whole mechanism exists for: Jira accepted it, the response never arrived.
    const client = createFakeJiraClient({
      commentAuthor: PLATFORM,
      addCommentBehaviour: 'land-then-throw',
    })

    const result = await writeBack(client, config(), item, pickup)

    expect(result.disposition).toBe('already-performed')
    // The caller is told it succeeded, so its retry loop never runs and no duplicate appears.
    expect(client.commentsOn('SIS-1')).toHaveLength(1)
  })

  it('posts once across a retry of the whole write-back', async () => {
    const client = createFakeJiraClient({ commentAuthor: PLATFORM })

    const first = await writeBack(client, config(), item, pickup)
    const second = await writeBack(client, config(), item, pickup)

    expect(first.disposition).toBe('performed')
    expect(second.disposition).toBe('already-performed')
    expect(client.commentsOn('SIS-1')).toHaveLength(1)
  })

  it('creates nothing when the lookup itself fails', async () => {
    // "Could not ask" is not "not there". Treating them the same is how the duplicate is posted.
    const client = createFakeJiraClient({
      commentAuthor: PLATFORM,
      listCommentsError: new Error('502 Bad Gateway'),
    })

    await expect(writeBack(client, config(), item, pickup)).rejects.toThrow('502')
    expect(client.posted).toEqual([])
  })

  it('propagates a rejection once Jira confirms it does not have the comment', async () => {
    const client = createFakeJiraClient({ commentAuthor: PLATFORM, addCommentBehaviour: 'throw' })

    await expect(writeBack(client, config(), item, pickup)).rejects.toThrow(
      'jira rejected the comment',
    )
    expect(client.commentsOn('SIS-1')).toHaveLength(0)
  })

  it('still posts the outcome comment on a ticket that already has the pickup comment', async () => {
    // Keyed by ticket alone, this is the comment that would be swallowed as a replay.
    const client = createFakeJiraClient({
      commentAuthor: PLATFORM,
      comments: { 'SIS-1': [previousAttempt(pickup)] },
    })

    const outcome: WriteBackEvent = {
      kind: 'outcome',
      workflowId: 'wf-1',
      outcome: 'completed',
      pullRequestUrls: ['https://github.com/acme/api/pull/1'],
    }

    const result = await writeBack(client, config(), item, outcome)

    expect(result.disposition).toBe('performed')
    expect(client.posted).toHaveLength(1)
  })

  it('comments once for a skip however many ticks re-observe it', async () => {
    const client = createFakeJiraClient({ commentAuthor: PLATFORM })
    const skip: WriteBackEvent = { kind: 'skipped', reason: 'no_mapping_matched' }

    await writeBack(client, config(), item, skip)
    await writeBack(client, config(), item, { ...skip, detail: 'Evaluated 3 mappings at 09:31.' })
    await writeBack(client, config(), item, { ...skip, detail: 'Evaluated 3 mappings at 09:36.' })

    // The free-text detail varies every tick; the identity does not, so the ticket is not spammed.
    expect(client.commentsOn('SIS-1')).toHaveLength(1)
  })

  it('lets a ticket skipped for a different reason say so', async () => {
    const client = createFakeJiraClient({ commentAuthor: PLATFORM })

    await writeBack(client, config(), item, { kind: 'skipped', reason: 'no_mapping_matched' })
    await writeBack(client, config(), item, { kind: 'skipped', reason: 'ceiling_reached' })

    expect(client.commentsOn('SIS-1')).toHaveLength(2)
  })

  it('is not fooled by a human pasting the marker', async () => {
    // A marker-only check would let anybody suppress the pickup comment by quoting an old one.
    const key = commentKey(item, pickup)
    const client = createFakeJiraClient({
      commentAuthor: PLATFORM,
      comments: {
        'SIS-1': [
          {
            id: 'human-quote',
            author: { accountId: 'harry' },
            body: `did this run? ${renderMarker(key)}`,
            created: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    })

    const result = await writeBack(client, config(), item, pickup)

    expect(result.disposition).toBe('performed')
    expect(result.reference).not.toBe('human-quote')
  })

  it('recognises a previous attempt further back than the first page of comments', async () => {
    const chatter = Array.from({ length: 12 }, (_unused, index) => ({
      id: `chatter-${String(index)}`,
      author: { accountId: 'harry' },
      body: 'discussion',
      created: '2026-01-01T00:00:00.000Z',
    }))
    const client = createFakeJiraClient({
      commentAuthor: PLATFORM,
      comments: { 'SIS-1': [...chatter, previousAttempt(pickup)] },
    })

    const result = await writeBack(client, config({ pageSize: 5 }), item, pickup)

    expect(client.commentReads.length).toBeGreaterThan(1)

    expect(result.disposition).toBe('already-performed')
    expect(client.posted).toEqual([])
  })

  it('refuses to comment when the platform identity cannot be established', async () => {
    // Without an identity it could neither recognise its own previous comment nor keep the one it
    // is about to post out of the next prompt.
    const client = createFakeJiraClient({ currentUser: {} })

    await expect(writeBack(client, config({ serviceAccount: {} }), item, pickup)).rejects.toThrow(
      /cannot tell its own comments/,
    )
    expect(client.posted).toEqual([])
  })
})
