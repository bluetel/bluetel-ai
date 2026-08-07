import { describe, expect, it } from 'vitest'

import { createFakeJiraClient } from './client-fake'

const issue = (key: string) => ({ key, fields: { summary: key } })

describe('createFakeJiraClient', () => {
  it('pages a search rather than returning everything at once', async () => {
    const client = createFakeJiraClient({ issues: [issue('A-1'), issue('A-2'), issue('A-3')] })

    const first = await client.searchIssues({ jql: 'x', startAt: 0, maxResults: 2 })
    const second = await client.searchIssues({ jql: 'x', startAt: 2, maxResults: 2 })

    expect(first.issues.map((found) => found.key)).toEqual(['A-1', 'A-2'])
    expect(second.issues.map((found) => found.key)).toEqual(['A-3'])
    expect(first.total).toBe(3)
    expect(client.searches).toHaveLength(2)
  })

  it('records the comment it accepted so a duplicate is visible', async () => {
    const client = createFakeJiraClient({ commentAuthor: { accountId: 'bot' } })

    await client.addComment({ issueKey: 'A-1', body: 'hello', idempotencyKey: 'k' })

    expect(client.posted).toEqual([{ issueKey: 'A-1', body: 'hello', idempotencyKey: 'k' }])
    expect(client.commentsOn('A-1')).toHaveLength(1)
    expect(client.commentsOn('A-1')[0]?.author).toEqual({ accountId: 'bot' })
  })

  it('models the comment that landed before the connection died', async () => {
    const client = createFakeJiraClient({ addCommentBehaviour: 'land-then-throw' })

    await expect(
      client.addComment({ issueKey: 'A-1', body: 'hello', idempotencyKey: 'k' }),
    ).rejects.toThrow()

    // The caller saw a failure; Jira has the comment. This is the state idempotency exists for.
    expect(client.commentsOn('A-1')).toHaveLength(1)
  })

  it('creates nothing when the deployment rejects the comment outright', async () => {
    const client = createFakeJiraClient({ addCommentBehaviour: 'throw' })

    await expect(
      client.addComment({ issueKey: 'A-1', body: 'hello', idempotencyKey: 'k' }),
    ).rejects.toThrow()

    expect(client.commentsOn('A-1')).toHaveLength(0)
    expect(client.posted).toHaveLength(0)
  })

  it('pages comments and records which issues were read', async () => {
    const client = createFakeJiraClient({
      comments: {
        'A-1': [
          { id: '1', body: 'one' },
          { id: '2', body: 'two' },
        ],
      },
    })

    const page = await client.listComments({ issueKey: 'A-1', startAt: 0, maxResults: 1 })

    expect(page.comments.map((comment) => comment.id)).toEqual(['1'])
    expect(page.total).toBe(2)
    expect(client.commentReads).toEqual(['A-1'])
  })

  it('reports an unreachable deployment as a rejection from currentUser', async () => {
    const client = createFakeJiraClient({ currentUserError: new Error('ENOTFOUND') })

    await expect(client.currentUser()).rejects.toThrow('ENOTFOUND')
    expect(client.currentUserCalls()).toBe(1)
  })
})
