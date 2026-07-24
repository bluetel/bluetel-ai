/* eslint-disable @typescript-eslint/no-non-null-assertion */
// Feature: kiro-github-worker
// Property 1: Label matching accepts only configured trigger labels
// Property 2: Event_Filter accepts events iff all required conditions are met
// Property 3: Event data extraction preserves all payload fields

import * as fc from 'fast-check'
import pino from 'pino'
import { describe, expect, it } from 'vitest'

import type {
  IssueCommentPayload,
  IssueEventPayload,
  PRReviewCommentPayload,
  PRReviewPayload,
} from '../lib/types.js'

import { createBranchMap } from './branch-map.js'
import { createEventFilter, type EventFilterConfig, type WebhookEvent } from './event-filter.js'

// ── Helpers ─────────────────────────────────────────────────────────

/** Silent pino logger that discards all output. */
const mockLogger = pino({ level: 'silent' })

/** Arbitrary that generates realistic GitHub repo full names (owner/repo). */
const repoNameArb = fc
  .tuple(
    fc.string({
      unit: fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', '1', '2', '3', '-', '_'),
      minLength: 1,
      maxLength: 10,
    }),
    fc.string({
      unit: fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', '1', '2', '3', '-', '_'),
      minLength: 1,
      maxLength: 10,
    }),
  )
  .map(([owner, repo]) => `${owner}/${repo}`)

/** Arbitrary that generates positive issue/PR numbers. */
const issueNumberArb = fc.integer({ min: 1, max: 100_000 })

/** Arbitrary that generates realistic branch names. */
const branchNameArb = fc
  .tuple(
    fc.constantFrom('kiro/', 'feature/', 'fix/', 'rocky/'),
    issueNumberArb,
    fc.string({
      unit: fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', '1', '2', '3', '-'),
      minLength: 1,
      maxLength: 20,
    }),
  )
  .map(([prefix, num, slug]) => `${prefix}${String(num)}-${slug}`)

/** Arbitrary that generates label names (simple alphanumeric + hyphens). */
const labelNameArb = fc.string({
  unit: fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', '1', '2', '3', '-'),
  minLength: 1,
  maxLength: 20,
})

/** Arbitrary that generates a non-empty set of unique label names. */
const labelListArb = fc.uniqueArray(labelNameArb, { minLength: 1, maxLength: 5 })

/** Arbitrary that generates a bot username. */
const botUsernameArb = fc.string({
  unit: fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', '1', '2', '3', '-'),
  minLength: 3,
  maxLength: 15,
})

/** Arbitrary that generates issue titles. */
const issueTitleArb = fc.string({ minLength: 1, maxLength: 50 })

/** Arbitrary that generates issue/comment bodies (may be null for issue body). */
const issueBodyArb = fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: null })

/** Arbitrary that generates comment body text (non-null). */
const commentBodyArb = fc.string({ minLength: 1, maxLength: 100 })

/** Arbitrary that generates file paths. */
const filePathArb = fc
  .tuple(
    fc.constantFrom('src/', 'lib/', 'test/', ''),
    fc.string({
      unit: fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', '.', '/'),
      minLength: 1,
      maxLength: 20,
    }),
  )
  .map(([prefix, rest]) => `${prefix}${rest}`)

/** Arbitrary that generates line numbers (nullable). */
const lineNumberArb = fc.option(fc.integer({ min: 1, max: 10_000 }), { nil: null })

// ── Payload Builders ────────────────────────────────────────────────

const buildIssueEventPayload = (
  repo: string,
  issueNumber: number,
  issueTitle: string,
  issueBody: string | null,
  labelName: string,
  issueLabels: string[],
): IssueEventPayload => ({
  action: 'labeled',
  repository: { full_name: repo },
  issue: {
    number: issueNumber,
    title: issueTitle,
    body: issueBody,
    labels: issueLabels.map((name) => ({ name })),
  },
  label: { name: labelName },
})

const buildIssueCommentPayload = (
  repo: string,
  issueNumber: number,
  issueTitle: string,
  issueBody: string | null,
  issueLabels: string[],
  commentBody: string,
  authorLogin: string,
  isPR: boolean = false,
  commentId: number = 12345,
): IssueCommentPayload => ({
  action: 'created',
  repository: { full_name: repo },
  issue: {
    number: issueNumber,
    title: issueTitle,
    body: issueBody,
    labels: issueLabels.map((name) => ({ name })),
    ...(isPR
      ? {
          pull_request: {
            url: `https://api.github.com/repos/${repo}/pulls/${String(issueNumber)}`,
          },
        }
      : {}),
  },
  comment: {
    id: commentId,
    body: commentBody,
    user: { login: authorLogin },
  },
})

const buildPRReviewCommentPayload = (
  repo: string,
  prNumber: number,
  branchRef: string,
  prAuthorLogin: string,
  commentBody: string,
  commentAuthorLogin: string,
  filePath: string,
  line: number | null,
  commentId: number = 12345,
): PRReviewCommentPayload => ({
  action: 'created',
  repository: { full_name: repo },
  pull_request: {
    number: prNumber,
    head: { ref: branchRef },
    user: { login: prAuthorLogin },
  },
  comment: {
    id: commentId,
    body: commentBody,
    path: filePath,
    line,
    user: { login: commentAuthorLogin },
  },
})

const buildPRReviewPayload = (
  repo: string,
  prNumber: number,
  branchRef: string,
  prAuthorLogin: string,
  reviewState: 'changes_requested' | 'approved' | 'commented',
  reviewBody: string | null,
  reviewAuthorLogin: string,
): PRReviewPayload => ({
  action: 'submitted',
  repository: { full_name: repo },
  pull_request: {
    number: prNumber,
    head: { ref: branchRef },
    user: { login: prAuthorLogin },
  },
  review: {
    state: reviewState,
    body: reviewBody,
    user: { login: reviewAuthorLogin },
  },
})

// ── Property 1: Label matching accepts only configured trigger labels ──
// **Validates: Requirements 2.2**

describe('Property 1: Label matching accepts only configured trigger labels', () => {
  it('returns non-null for issues.labeled when the added label is in triggerLabels', () => {
    fc.assert(
      fc.property(
        labelListArb,
        botUsernameArb,
        repoNameArb,
        issueNumberArb,
        issueTitleArb,
        issueBodyArb,
        (triggerLabels, botUsername, repo, issueNumber, issueTitle, issueBody) => {
          // Pick a label from the trigger labels set
          const labelIndex = issueNumber % triggerLabels.length
          const addedLabel = triggerLabels[labelIndex]

          const config: EventFilterConfig = { triggerLabels, botUsername }
          const branchMap = createBranchMap(botUsername, mockLogger)
          const filterEvent = createEventFilter(config, branchMap, mockLogger)

          const event: WebhookEvent = {
            name: 'issues.labeled',
            payload: buildIssueEventPayload(
              repo,
              issueNumber,
              issueTitle,
              issueBody,
              addedLabel,
              triggerLabels,
            ),
          }

          const result = filterEvent(event)
          expect(result).not.toBeNull()
          expect(result!.type).toBe('new_issue')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('returns null for issues.labeled when the added label is NOT in triggerLabels', () => {
    fc.assert(
      fc.property(
        labelListArb,
        labelNameArb,
        botUsernameArb,
        repoNameArb,
        issueNumberArb,
        issueTitleArb,
        issueBodyArb,
        (triggerLabels, addedLabel, botUsername, repo, issueNumber, issueTitle, issueBody) => {
          // Ensure the added label is not in the trigger labels
          fc.pre(!triggerLabels.includes(addedLabel))

          const config: EventFilterConfig = { triggerLabels, botUsername }
          const branchMap = createBranchMap(botUsername, mockLogger)
          const filterEvent = createEventFilter(config, branchMap, mockLogger)

          const event: WebhookEvent = {
            name: 'issues.labeled',
            payload: buildIssueEventPayload(repo, issueNumber, issueTitle, issueBody, addedLabel, [
              addedLabel,
            ]),
          }

          const result = filterEvent(event)
          expect(result).toBeNull()
        },
      ),
      { numRuns: 100 },
    )
  })

  it('returns non-null iff the added label is an element of the configured trigger labels', () => {
    fc.assert(
      fc.property(
        labelListArb,
        labelNameArb,
        botUsernameArb,
        repoNameArb,
        issueNumberArb,
        issueTitleArb,
        issueBodyArb,
        (triggerLabels, addedLabel, botUsername, repo, issueNumber, issueTitle, issueBody) => {
          const config: EventFilterConfig = { triggerLabels, botUsername }
          const branchMap = createBranchMap(botUsername, mockLogger)
          const filterEvent = createEventFilter(config, branchMap, mockLogger)

          const event: WebhookEvent = {
            name: 'issues.labeled',
            payload: buildIssueEventPayload(repo, issueNumber, issueTitle, issueBody, addedLabel, [
              addedLabel,
            ]),
          }

          const result = filterEvent(event)
          const shouldMatch = triggerLabels.includes(addedLabel)

          if (shouldMatch) {
            expect(result).not.toBeNull()
          } else {
            expect(result).toBeNull()
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ── Property 2: Event_Filter accepts events iff all required conditions are met ──
// **Validates: Requirements 2.3, 2.4, 2.5, 2.6, 7.1, 7.4**

describe('Property 2: Event_Filter accepts events iff all required conditions are met', () => {
  // ── Issue comments (non-PR) ──

  it('accepts issue comments iff issue has trigger label AND comment mentions bot AND author is not bot', () => {
    fc.assert(
      fc.property(
        labelListArb,
        labelNameArb,
        botUsernameArb,
        repoNameArb,
        issueNumberArb,
        issueTitleArb,
        issueBodyArb,
        commentBodyArb,
        fc.boolean(),
        fc.boolean(),
        (
          triggerLabels,
          extraLabel,
          botUsername,
          repo,
          issueNumber,
          issueTitle,
          issueBody,
          baseCommentBody,
          hasLabel,
          hasMention,
        ) => {
          const authorLogin = `user-${botUsername}-other`
          fc.pre(authorLogin !== botUsername)

          // Build issue labels: include a trigger label or not
          const issueLabels = hasLabel ? [triggerLabels[0]] : [extraLabel]
          // Ensure extraLabel is not a trigger label when hasLabel is false
          if (!hasLabel) {
            fc.pre(!triggerLabels.includes(extraLabel))
          }

          // Build comment body: include bot mention or not
          const commentBody = hasMention
            ? `${baseCommentBody} @${botUsername} please help`
            : baseCommentBody
          // Ensure the base comment body doesn't accidentally contain the mention
          if (!hasMention) {
            fc.pre(!commentBody.includes(`@${botUsername}`))
          }

          const config: EventFilterConfig = { triggerLabels, botUsername }
          const branchMap = createBranchMap(botUsername, mockLogger)
          const filterEvent = createEventFilter(config, branchMap, mockLogger)

          const event: WebhookEvent = {
            name: 'issue_comment.created',
            payload: buildIssueCommentPayload(
              repo,
              issueNumber,
              issueTitle,
              issueBody,
              issueLabels,
              commentBody,
              authorLogin,
              false,
            ),
          }

          const result = filterEvent(event)
          const shouldMatch = hasLabel && hasMention

          if (shouldMatch) {
            expect(result).not.toBeNull()
            expect(result!.type).toBe('follow_up_comment')
          } else {
            expect(result).toBeNull()
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('rejects issue comments authored by the bot itself', () => {
    fc.assert(
      fc.property(
        labelListArb,
        botUsernameArb,
        repoNameArb,
        issueNumberArb,
        issueTitleArb,
        issueBodyArb,
        commentBodyArb,
        (triggerLabels, botUsername, repo, issueNumber, issueTitle, issueBody, baseCommentBody) => {
          const commentBody = `${baseCommentBody} @${botUsername}`
          const config: EventFilterConfig = { triggerLabels, botUsername }
          const branchMap = createBranchMap(botUsername, mockLogger)
          const filterEvent = createEventFilter(config, branchMap, mockLogger)

          // Author is the bot itself
          const event: WebhookEvent = {
            name: 'issue_comment.created',
            payload: buildIssueCommentPayload(
              repo,
              issueNumber,
              issueTitle,
              issueBody,
              triggerLabels,
              commentBody,
              botUsername,
              false,
            ),
          }

          expect(filterEvent(event)).toBeNull()
        },
      ),
      { numRuns: 100 },
    )
  })

  // ── PR review comments ──

  it('accepts PR review comments iff comment mentions bot AND author is not bot', () => {
    fc.assert(
      fc.property(
        labelListArb,
        botUsernameArb,
        repoNameArb,
        issueNumberArb,
        issueNumberArb,
        branchNameArb,
        commentBodyArb,
        filePathArb,
        lineNumberArb,
        fc.boolean(),
        (
          triggerLabels,
          botUsername,
          repo,
          _issueNumber,
          prNumber,
          branchRef,
          baseCommentBody,
          filePath,
          line,
          hasMention,
        ) => {
          const commentAuthor = `reviewer-${botUsername}-x`
          fc.pre(commentAuthor !== botUsername)

          const commentBody = hasMention ? `${baseCommentBody} @${botUsername}` : baseCommentBody
          if (!hasMention) {
            fc.pre(!commentBody.includes(`@${botUsername}`))
          }

          const config: EventFilterConfig = { triggerLabels, botUsername }
          const branchMap = createBranchMap(botUsername, mockLogger)

          const filterEvent = createEventFilter(config, branchMap, mockLogger)

          const event: WebhookEvent = {
            name: 'pull_request_review_comment.created',
            payload: buildPRReviewCommentPayload(
              repo,
              prNumber,
              branchRef,
              `other-${botUsername}-y`,
              commentBody,
              commentAuthor,
              filePath,
              line,
            ),
          }

          const result = filterEvent(event)

          if (hasMention) {
            expect(result).not.toBeNull()
            expect(result!.type).toBe('pr_review_comment')
          } else {
            expect(result).toBeNull()
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('rejects PR review comments authored by the bot itself', () => {
    fc.assert(
      fc.property(
        labelListArb,
        botUsernameArb,
        repoNameArb,
        issueNumberArb,
        issueNumberArb,
        branchNameArb,
        commentBodyArb,
        filePathArb,
        lineNumberArb,
        (
          triggerLabels,
          botUsername,
          repo,
          issueNumber,
          prNumber,
          branchRef,
          baseCommentBody,
          filePath,
          line,
        ) => {
          const commentBody = `${baseCommentBody} @${botUsername}`
          const config: EventFilterConfig = { triggerLabels, botUsername }
          const branchMap = createBranchMap(botUsername, mockLogger)
          branchMap.set(repo, issueNumber, branchRef)

          const filterEvent = createEventFilter(config, branchMap, mockLogger)

          const event: WebhookEvent = {
            name: 'pull_request_review_comment.created',
            payload: buildPRReviewCommentPayload(
              repo,
              prNumber,
              branchRef,
              botUsername,
              commentBody,
              botUsername, // author is the bot
              filePath,
              line,
            ),
          }

          expect(filterEvent(event)).toBeNull()
        },
      ),
      { numRuns: 100 },
    )
  })

  // ── PR reviews with changes_requested ──

  it('accepts PR reviews with changes_requested when author is not bot (no mention required)', () => {
    fc.assert(
      fc.property(
        labelListArb,
        botUsernameArb,
        repoNameArb,
        issueNumberArb,
        issueNumberArb,
        branchNameArb,
        issueBodyArb,
        (triggerLabels, botUsername, repo, _issueNumber, prNumber, branchRef, reviewBody) => {
          const reviewAuthor = `reviewer-${botUsername}-z`
          fc.pre(reviewAuthor !== botUsername)

          const config: EventFilterConfig = { triggerLabels, botUsername }
          const branchMap = createBranchMap(botUsername, mockLogger)

          const filterEvent = createEventFilter(config, branchMap, mockLogger)

          const event: WebhookEvent = {
            name: 'pull_request_review.submitted',
            payload: buildPRReviewPayload(
              repo,
              prNumber,
              branchRef,
              `other-${botUsername}-w`,
              'changes_requested',
              reviewBody,
              reviewAuthor,
            ),
          }

          const result = filterEvent(event)
          expect(result).not.toBeNull()
          expect(result!.type).toBe('pr_review_changes_requested')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('rejects PR reviews that are not changes_requested', () => {
    fc.assert(
      fc.property(
        labelListArb,
        botUsernameArb,
        repoNameArb,
        issueNumberArb,
        issueNumberArb,
        branchNameArb,
        issueBodyArb,
        fc.constantFrom('approved' as const, 'commented' as const),
        (
          triggerLabels,
          botUsername,
          repo,
          issueNumber,
          prNumber,
          branchRef,
          reviewBody,
          reviewState,
        ) => {
          const reviewAuthor = `reviewer-${botUsername}-z`
          fc.pre(reviewAuthor !== botUsername)

          const config: EventFilterConfig = { triggerLabels, botUsername }
          const branchMap = createBranchMap(botUsername, mockLogger)
          branchMap.set(repo, issueNumber, branchRef)

          const filterEvent = createEventFilter(config, branchMap, mockLogger)

          const event: WebhookEvent = {
            name: 'pull_request_review.submitted',
            payload: buildPRReviewPayload(
              repo,
              prNumber,
              branchRef,
              botUsername,
              reviewState,
              reviewBody,
              reviewAuthor,
            ),
          }

          expect(filterEvent(event)).toBeNull()
        },
      ),
      { numRuns: 100 },
    )
  })

  it('rejects PR reviews authored by the bot itself', () => {
    fc.assert(
      fc.property(
        labelListArb,
        botUsernameArb,
        repoNameArb,
        issueNumberArb,
        issueNumberArb,
        branchNameArb,
        issueBodyArb,
        (triggerLabels, botUsername, repo, issueNumber, prNumber, branchRef, reviewBody) => {
          const config: EventFilterConfig = { triggerLabels, botUsername }
          const branchMap = createBranchMap(botUsername, mockLogger)
          branchMap.set(repo, issueNumber, branchRef)

          const filterEvent = createEventFilter(config, branchMap, mockLogger)

          const event: WebhookEvent = {
            name: 'pull_request_review.submitted',
            payload: buildPRReviewPayload(
              repo,
              prNumber,
              branchRef,
              botUsername,
              'changes_requested',
              reviewBody,
              botUsername, // reviewer is the bot
            ),
          }

          expect(filterEvent(event)).toBeNull()
        },
      ),
      { numRuns: 100 },
    )
  })

  // ── Issue comments on PRs ──
  // Note: PR issue comments use branchMap.findByPR() which requires the prIndex
  // populated during rebuild(). Property tests for this path would require mocking
  // the GitHub API. We cover this with example-based tests instead.

  it('accepts issue comments on PRs when comment mentions bot', () => {
    const botUsername = 'rocky-bot'
    const config: EventFilterConfig = { triggerLabels: ['agent-action'], botUsername }
    const branchMap = createBranchMap(botUsername, mockLogger)
    const filterEvent = createEventFilter(config, branchMap, mockLogger)

    const event: WebhookEvent = {
      name: 'issue_comment.created',
      payload: buildIssueCommentPayload(
        'org/repo',
        42,
        'Test issue',
        'Test body',
        ['agent-action'],
        `Hey @${botUsername} fix this`,
        'some-user',
        true, // isPR
      ),
    }

    const result = filterEvent(event)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('pr_comment')
  })
})

// ── Property 3: Event data extraction preserves all payload fields ──
// **Validates: Requirements 2.8, 2.9**

describe('Property 3: Event data extraction preserves all payload fields', () => {
  it('new_issue events preserve repo, issueNumber, issueTitle, and issueBody from payload', () => {
    fc.assert(
      fc.property(
        botUsernameArb,
        repoNameArb,
        issueNumberArb,
        issueTitleArb,
        issueBodyArb,
        (botUsername, repo, issueNumber, issueTitle, issueBody) => {
          const triggerLabel = 'agent-action'
          const config: EventFilterConfig = { triggerLabels: [triggerLabel], botUsername }
          const branchMap = createBranchMap(botUsername, mockLogger)
          const filterEvent = createEventFilter(config, branchMap, mockLogger)

          const event: WebhookEvent = {
            name: 'issues.labeled',
            payload: buildIssueEventPayload(
              repo,
              issueNumber,
              issueTitle,
              issueBody,
              triggerLabel,
              [triggerLabel],
            ),
          }

          const result = filterEvent(event)
          expect(result).not.toBeNull()
          expect(result!.type).toBe('new_issue')

          if (result!.type === 'new_issue') {
            expect(result!.repo).toBe(repo)
            expect(result!.issueNumber).toBe(issueNumber)
            expect(result!.issueTitle).toBe(issueTitle)
            expect(result!.issueBody).toBe(issueBody ?? '')
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('follow_up_comment events preserve repo, issueNumber, issueTitle, issueBody, and commentBody', () => {
    fc.assert(
      fc.property(
        botUsernameArb,
        repoNameArb,
        issueNumberArb,
        issueTitleArb,
        issueBodyArb,
        commentBodyArb,
        (botUsername, repo, issueNumber, issueTitle, issueBody, baseCommentBody) => {
          const triggerLabel = 'agent-action'
          const authorLogin = `user-${botUsername}-test`
          fc.pre(authorLogin !== botUsername)

          const commentBody = `${baseCommentBody} @${botUsername}`
          // Ensure the comment doesn't contain the rocky-worker marker
          fc.pre(!commentBody.includes('<!-- rocky-worker -->'))

          const config: EventFilterConfig = { triggerLabels: [triggerLabel], botUsername }
          const branchMap = createBranchMap(botUsername, mockLogger)
          const filterEvent = createEventFilter(config, branchMap, mockLogger)

          const event: WebhookEvent = {
            name: 'issue_comment.created',
            payload: buildIssueCommentPayload(
              repo,
              issueNumber,
              issueTitle,
              issueBody,
              [triggerLabel],
              commentBody,
              authorLogin,
              false,
            ),
          }

          const result = filterEvent(event)
          expect(result).not.toBeNull()
          expect(result!.type).toBe('follow_up_comment')

          if (result!.type === 'follow_up_comment') {
            expect(result!.repo).toBe(repo)
            expect(result!.issueNumber).toBe(issueNumber)
            expect(result!.issueTitle).toBe(issueTitle)
            expect(result!.issueBody).toBe(issueBody ?? '')
            expect(result!.commentBody).toBe(commentBody)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('pr_review_comment events preserve repo, prNumber, commentBody, filePath, and lineContext', () => {
    fc.assert(
      fc.property(
        botUsernameArb,
        repoNameArb,
        issueNumberArb,
        issueNumberArb,
        branchNameArb,
        commentBodyArb,
        filePathArb,
        lineNumberArb,
        (botUsername, repo, issueNumber, prNumber, branchRef, baseCommentBody, filePath, line) => {
          const commentAuthor = `reviewer-${botUsername}-abc`
          fc.pre(commentAuthor !== botUsername)

          const commentBody = `${baseCommentBody} @${botUsername}`
          fc.pre(!commentBody.includes('<!-- rocky-worker -->'))

          const config: EventFilterConfig = { triggerLabels: ['agent-action'], botUsername }
          const branchMap = createBranchMap(botUsername, mockLogger)
          branchMap.set(repo, issueNumber, branchRef)

          const filterEvent = createEventFilter(config, branchMap, mockLogger)

          const event: WebhookEvent = {
            name: 'pull_request_review_comment.created',
            payload: buildPRReviewCommentPayload(
              repo,
              prNumber,
              branchRef,
              'some-pr-author',
              commentBody,
              commentAuthor,
              filePath,
              line,
            ),
          }

          const result = filterEvent(event)
          expect(result).not.toBeNull()
          expect(result!.type).toBe('pr_review_comment')

          if (result!.type === 'pr_review_comment') {
            expect(result!.repo).toBe(repo)
            expect(result!.prNumber).toBe(prNumber)
            expect(result!.commentBody).toBe(commentBody)
            expect(result!.filePath).toBe(filePath)
            expect(result!.issueNumber).toBe(issueNumber)
            // lineContext should be "Line N" when line is present, empty string otherwise
            if (line != null) {
              expect(result!.lineContext).toBe(`Line ${String(line)}`)
            } else {
              expect(result!.lineContext).toBe('')
            }
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('pr_review_changes_requested events preserve repo, prNumber, reviewBody, and issueNumber', () => {
    fc.assert(
      fc.property(
        botUsernameArb,
        repoNameArb,
        issueNumberArb,
        issueNumberArb,
        branchNameArb,
        issueBodyArb,
        (botUsername, repo, issueNumber, prNumber, branchRef, reviewBody) => {
          const reviewAuthor = `reviewer-${botUsername}-def`
          fc.pre(reviewAuthor !== botUsername)

          const config: EventFilterConfig = { triggerLabels: ['agent-action'], botUsername }
          const branchMap = createBranchMap(botUsername, mockLogger)
          branchMap.set(repo, issueNumber, branchRef)

          const filterEvent = createEventFilter(config, branchMap, mockLogger)

          const event: WebhookEvent = {
            name: 'pull_request_review.submitted',
            payload: buildPRReviewPayload(
              repo,
              prNumber,
              branchRef,
              'some-pr-author',
              'changes_requested',
              reviewBody,
              reviewAuthor,
            ),
          }

          const result = filterEvent(event)
          expect(result).not.toBeNull()
          expect(result!.type).toBe('pr_review_changes_requested')

          if (result!.type === 'pr_review_changes_requested') {
            expect(result!.repo).toBe(repo)
            expect(result!.prNumber).toBe(prNumber)
            expect(result!.reviewBody).toBe(reviewBody ?? '')
            expect(result!.issueNumber).toBe(issueNumber)
            expect(result!.reviewComments).toEqual([])
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
