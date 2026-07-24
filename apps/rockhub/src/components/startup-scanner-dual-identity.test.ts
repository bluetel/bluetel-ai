/**
 * Startup_Scanner dual-identity reaction check tests (Property 25).
 *
 * Validates: Requirements 5.4, 5.5, 18.6
 *
 * Property 25: For any source object with reactions set R, the scanner
 * treats it as "already processed" iff there exists r ∈ R where
 * r.content === 'eyes' AND (r.user.login case-insensitively equals
 * BOT_USERNAME OR r.user.login case-insensitively equals appBotLogin).
 */

import type { Octokit } from '@octokit/rest'
import pino from 'pino'
import { describe, it, expect, vi } from 'vitest'

import type { RawWebhookEvent, TriggerMention } from '../lib'

import type { MentionQueueInstance, QueuedMention } from './mention-queue'
import { createStartupScanner } from './startup-scanner'

const logger = pino({ level: 'silent' })

const BOT_USERNAME = 'my-bot'
const APP_BOT_LOGIN = 'my-rockhub-app[bot]'

/**
 * Creates a mock Octokit that returns a single repo with a single issue
 * that mentions the bot. The reactions on that issue are configurable.
 */
const createMockOctokit = (
  reactions: Array<{ content: string; user: { login: string } | null }>,
): Octokit => {
  const issue = {
    number: 1,
    title: 'Test issue',
    body: `Hey @${BOT_USERNAME} help me`,
    user: { login: 'alice', id: 100 },
    pull_request: null,
  }

  // Track calls to listForRepo to differentiate open-issues vs assigned-issues
  let listForRepoCallCount = 0

  /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */
  const octokit: any = {
    paginate: { iterator: vi.fn() },
    apps: { listReposAccessibleToInstallation: vi.fn() },
    issues: { listForRepo: vi.fn(), listCommentsForRepo: vi.fn() },
    pulls: { list: vi.fn(), listReviewCommentsForRepo: vi.fn() },
    reactions: {
      listForIssue: vi.fn().mockResolvedValue({ data: reactions }),
      listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
      listForPullRequestReviewComment: vi.fn().mockResolvedValue({ data: [] }),
    },
  }

  octokit.paginate.iterator.mockImplementation((method: unknown) => {
    if (method === octokit.apps.listReposAccessibleToInstallation) {
      return (function* () {
        yield { data: [{ full_name: 'owner/repo', name: 'repo', owner: { login: 'owner' } }] }
      })()
    }
    if (method === octokit.issues.listForRepo) {
      listForRepoCallCount++
      if (listForRepoCallCount === 1) {
        // First call: listOpenIssues — return the issue with bot mention
        return (function* () {
          yield { data: [issue] }
        })()
      }
      // Second call: listAssignedIssues — return empty (not assigned to bot)
      return (function* () {
        yield { data: [] }
      })()
    }
    if (method === octokit.pulls.list) {
      return (function* () {
        yield { data: [] }
      })()
    }
    if (method === octokit.issues.listCommentsForRepo) {
      return (function* () {
        yield { data: [] }
      })()
    }
    if (method === octokit.pulls.listReviewCommentsForRepo) {
      return (function* () {
        yield { data: [] }
      })()
    }
    return (function* () {
      yield { data: [] }
    })()
  })
  /* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */

  return octokit as unknown as Octokit
}

const createMockMentionQueue = (): MentionQueueInstance & { offered: QueuedMention[] } => {
  const offered: QueuedMention[] = []
  return {
    offered,
    offer: vi.fn((item: QueuedMention) => {
      offered.push(item)
      return true
    }),
    has: vi.fn(() => false),
    size: () => 0,
    processedCount: () => 0,
    start: vi.fn(),
    drain: vi.fn().mockResolvedValue(undefined),
  }
}

const createMockEventFilter =
  (): ((raw: RawWebhookEvent) => TriggerMention | null) => (raw: RawWebhookEvent) => {
    // Simple event filter that returns a TriggerMention for issues with bot mention
    if (raw.name === 'issues.opened') {
      const body = raw.payload.issue.body ?? ''
      if (body.toLowerCase().includes(`@${BOT_USERNAME.toLowerCase()}`)) {
        return {
          identity: `owner/repo:issue_body:${raw.payload.issue.number}`,
          sourceType: 'issue_body',
          sourceId: String(raw.payload.issue.number),
          repoFullName: 'owner/repo',
          owner: 'owner',
          repo: 'repo',
          issueOrPrNumber: raw.payload.issue.number,
          actor: raw.payload.sender.login,
        }
      }
    }
    return null
  }

describe('Property 25: Startup_Scanner dual-identity reaction check', () => {
  it('skips source objects with eyes reaction from BOT_USERNAME', async () => {
    const reactions = [{ content: 'eyes', user: { login: BOT_USERNAME } }]
    const octokit = createMockOctokit(reactions)
    const mentionQueue = createMockMentionQueue()

    const scanner = createStartupScanner({
      octokit,
      botUsername: BOT_USERNAME,
      appBotLogin: APP_BOT_LOGIN,
      repoFilter: () => true,
      eventFilter: createMockEventFilter(),
      mentionQueue,
      logger,
    })

    const result = await scanner.scan()

    // The issue has an eyes reaction from BOT_USERNAME, so it should be skipped
    expect(mentionQueue.offered).toHaveLength(0)
    expect(result.enqueued).toBe(0)
  })

  it('skips source objects with eyes reaction from appBotLogin', async () => {
    const reactions = [{ content: 'eyes', user: { login: APP_BOT_LOGIN } }]
    const octokit = createMockOctokit(reactions)
    const mentionQueue = createMockMentionQueue()

    const scanner = createStartupScanner({
      octokit,
      botUsername: BOT_USERNAME,
      appBotLogin: APP_BOT_LOGIN,
      repoFilter: () => true,
      eventFilter: createMockEventFilter(),
      mentionQueue,
      logger,
    })

    const result = await scanner.scan()

    // The issue has an eyes reaction from appBotLogin, so it should be skipped
    expect(mentionQueue.offered).toHaveLength(0)
    expect(result.enqueued).toBe(0)
  })

  it('skips source objects with eyes reaction from both identities', async () => {
    const reactions = [
      { content: 'eyes', user: { login: BOT_USERNAME } },
      { content: 'eyes', user: { login: APP_BOT_LOGIN } },
    ]
    const octokit = createMockOctokit(reactions)
    const mentionQueue = createMockMentionQueue()

    const scanner = createStartupScanner({
      octokit,
      botUsername: BOT_USERNAME,
      appBotLogin: APP_BOT_LOGIN,
      repoFilter: () => true,
      eventFilter: createMockEventFilter(),
      mentionQueue,
      logger,
    })

    const result = await scanner.scan()

    expect(mentionQueue.offered).toHaveLength(0)
    expect(result.enqueued).toBe(0)
  })

  it('enqueues source objects with NO eyes reaction from either identity', async () => {
    // Reactions from an unrelated user (not eyes by bot or app)
    const reactions = [{ content: 'thumbs_up', user: { login: 'random-user' } }]
    const octokit = createMockOctokit(reactions)
    const mentionQueue = createMockMentionQueue()

    const scanner = createStartupScanner({
      octokit,
      botUsername: BOT_USERNAME,
      appBotLogin: APP_BOT_LOGIN,
      repoFilter: () => true,
      eventFilter: createMockEventFilter(),
      mentionQueue,
      logger,
    })

    const result = await scanner.scan()

    // No eyes reaction from either identity — should be enqueued
    expect(mentionQueue.offered).toHaveLength(1)
    expect(result.enqueued).toBe(1)
  })

  it('enqueues source objects with eyes reaction from an unrelated user', async () => {
    // Eyes reaction exists but from a different user
    const reactions = [{ content: 'eyes', user: { login: 'unrelated-user' } }]
    const octokit = createMockOctokit(reactions)
    const mentionQueue = createMockMentionQueue()

    const scanner = createStartupScanner({
      octokit,
      botUsername: BOT_USERNAME,
      appBotLogin: APP_BOT_LOGIN,
      repoFilter: () => true,
      eventFilter: createMockEventFilter(),
      mentionQueue,
      logger,
    })

    const result = await scanner.scan()

    // Eyes from unrelated user doesn't count — should be enqueued
    expect(mentionQueue.offered).toHaveLength(1)
    expect(result.enqueued).toBe(1)
  })

  it('performs case-insensitive matching on BOT_USERNAME', async () => {
    // Reaction from BOT_USERNAME but with different casing
    const reactions = [{ content: 'eyes', user: { login: 'MY-BOT' } }]
    const octokit = createMockOctokit(reactions)
    const mentionQueue = createMockMentionQueue()

    const scanner = createStartupScanner({
      octokit,
      botUsername: BOT_USERNAME, // 'my-bot'
      appBotLogin: APP_BOT_LOGIN,
      repoFilter: () => true,
      eventFilter: createMockEventFilter(),
      mentionQueue,
      logger,
    })

    const result = await scanner.scan()

    // 'MY-BOT' should match 'my-bot' case-insensitively — skipped
    expect(mentionQueue.offered).toHaveLength(0)
    expect(result.enqueued).toBe(0)
  })

  it('performs case-insensitive matching on appBotLogin', async () => {
    // Reaction from appBotLogin but with different casing
    const reactions = [{ content: 'eyes', user: { login: 'My-Rockhub-App[BOT]' } }]
    const octokit = createMockOctokit(reactions)
    const mentionQueue = createMockMentionQueue()

    const scanner = createStartupScanner({
      octokit,
      botUsername: BOT_USERNAME,
      appBotLogin: APP_BOT_LOGIN, // 'my-rockhub-app[bot]'
      repoFilter: () => true,
      eventFilter: createMockEventFilter(),
      mentionQueue,
      logger,
    })

    const result = await scanner.scan()

    // 'My-Rockhub-App[BOT]' should match 'my-rockhub-app[bot]' case-insensitively — skipped
    expect(mentionQueue.offered).toHaveLength(0)
    expect(result.enqueued).toBe(0)
  })
})
