// Feature: kiro-github-worker
// Property 11: Job queue key derivation produces correct format
// Property 12: Job queue sequential invariant per key
// Property 13: Job queue allows parallelism across different keys

import * as fc from 'fast-check'
import pino from 'pino'
import { describe, expect, it } from 'vitest'

import type { FilteredEvent } from '../lib/types.js'

import { createJobQueue, deriveQueueKey } from './job-queue.js'

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

/** Arbitrary that generates positive PR numbers. */
const prNumberArb = fc.integer({ min: 1, max: 100_000 })

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

/** Arbitrary for a new_issue FilteredEvent. */
const newIssueEventArb = fc.record({
  type: fc.constant('new_issue' as const),
  repo: repoNameArb,
  issueNumber: issueNumberArb,
  issueTitle: fc.string({ minLength: 1, maxLength: 50 }),
  issueBody: fc.string({ maxLength: 200 }),
})

/** Arbitrary for a follow_up_comment FilteredEvent. */
const followUpEventArb = fc.record({
  type: fc.constant('follow_up_comment' as const),
  repo: repoNameArb,
  issueNumber: issueNumberArb,
  issueTitle: fc.string({ minLength: 1, maxLength: 50 }),
  issueBody: fc.string({ maxLength: 200 }),
  commentBody: fc.string({ minLength: 1, maxLength: 200 }),
  commentId: fc.integer({ min: 1, max: 999_999 }),
})

/** Arbitrary for a pr_review_comment FilteredEvent with a known issue number. */
const prReviewCommentWithIssueArb = fc.record({
  type: fc.constant('pr_review_comment' as const),
  repo: repoNameArb,
  prNumber: prNumberArb,
  issueNumber: issueNumberArb.map((n): number => n),
  commentBody: fc.string({ minLength: 1, maxLength: 200 }),
  commentId: fc.integer({ min: 1, max: 999_999 }),
  filePath: fc.string({ minLength: 1, maxLength: 50 }),
  lineContext: fc.string({ maxLength: 100 }),
  branchRef: branchNameArb,
})

/** Arbitrary for a pr_review_comment FilteredEvent without an issue number. */
const prReviewCommentWithoutIssueArb = fc.record({
  type: fc.constant('pr_review_comment' as const),
  repo: repoNameArb,
  prNumber: prNumberArb,
  issueNumber: fc.constant(null),
  commentBody: fc.string({ minLength: 1, maxLength: 200 }),
  commentId: fc.integer({ min: 1, max: 999_999 }),
  filePath: fc.string({ minLength: 1, maxLength: 50 }),
  lineContext: fc.string({ maxLength: 100 }),
  branchRef: branchNameArb,
})

/** Arbitrary for a pr_review_changes_requested FilteredEvent with a known issue number. */
const prReviewChangesWithIssueArb = fc.record({
  type: fc.constant('pr_review_changes_requested' as const),
  repo: repoNameArb,
  prNumber: prNumberArb,
  issueNumber: issueNumberArb.map((n): number => n),
  reviewBody: fc.string({ maxLength: 200 }),
  reviewComments: fc.constant([]),
  branchRef: branchNameArb,
})

/** Arbitrary for a pr_review_changes_requested FilteredEvent without an issue number. */
const prReviewChangesWithoutIssueArb = fc.record({
  type: fc.constant('pr_review_changes_requested' as const),
  repo: repoNameArb,
  prNumber: prNumberArb,
  issueNumber: fc.constant(null),
  reviewBody: fc.string({ maxLength: 200 }),
  reviewComments: fc.constant([]),
  branchRef: branchNameArb,
})

/** Arbitrary for a pr_comment FilteredEvent with a known issue number. */
const prCommentWithIssueArb = fc.record({
  type: fc.constant('pr_comment' as const),
  repo: repoNameArb,
  prNumber: prNumberArb,
  issueNumber: issueNumberArb.map((n): number => n),
  commentBody: fc.string({ minLength: 1, maxLength: 200 }),
  commentId: fc.integer({ min: 1, max: 999_999 }),
  branchRef: fc.option(branchNameArb, { nil: null }),
})

/** Arbitrary for a pr_comment FilteredEvent without an issue number. */
const prCommentWithoutIssueArb = fc.record({
  type: fc.constant('pr_comment' as const),
  repo: repoNameArb,
  prNumber: prNumberArb,
  issueNumber: fc.constant(null),
  commentBody: fc.string({ minLength: 1, maxLength: 200 }),
  commentId: fc.integer({ min: 1, max: 999_999 }),
  branchRef: fc.option(branchNameArb, { nil: null }),
})

/** Arbitrary for any FilteredEvent with an issue number available. */
const eventWithIssueNumberArb: fc.Arbitrary<FilteredEvent> = fc.oneof(
  newIssueEventArb,
  followUpEventArb,
  prReviewCommentWithIssueArb,
  prReviewChangesWithIssueArb,
  prCommentWithIssueArb,
)

/** Arbitrary for any PR FilteredEvent without an issue number. */
const eventWithoutIssueNumberArb: fc.Arbitrary<FilteredEvent> = fc.oneof(
  prReviewCommentWithoutIssueArb,
  prReviewChangesWithoutIssueArb,
  prCommentWithoutIssueArb,
)

/** Arbitrary for any FilteredEvent. */
const anyFilteredEventArb: fc.Arbitrary<FilteredEvent> = fc.oneof(
  eventWithIssueNumberArb,
  eventWithoutIssueNumberArb,
)

/**
 * Helper to create a deferred promise that can be resolved externally.
 */
const deferred = (): {
  promise: Promise<void>
  resolve: () => void
  reject: (err: Error) => void
} => {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ── Property 11: Job queue key derivation produces correct format ──
// **Validates: Requirements 12.1, 12.10, 12.11**

describe('Property 11: Job queue key derivation produces correct format', () => {
  it('derives {repo}:{issueNumber} for new_issue events', () => {
    fc.assert(
      fc.property(newIssueEventArb, (event) => {
        const key = deriveQueueKey(event)
        expect(key).toBe(`${event.repo}:${String(event.issueNumber)}`)
      }),
      { numRuns: 100 },
    )
  })

  it('derives {repo}:{issueNumber} for follow_up_comment events', () => {
    fc.assert(
      fc.property(followUpEventArb, (event) => {
        const key = deriveQueueKey(event)
        expect(key).toBe(`${event.repo}:${String(event.issueNumber)}`)
      }),
      { numRuns: 100 },
    )
  })

  it('derives {repo}:{issueNumber} for PR events when issueNumber is available', () => {
    fc.assert(
      fc.property(
        fc.oneof(prReviewCommentWithIssueArb, prReviewChangesWithIssueArb, prCommentWithIssueArb),
        (event) => {
          const key = deriveQueueKey(event)
          expect(key).toBe(`${event.repo}:${String(event.issueNumber)}`)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('derives {repo}:pr-{prNumber} for PR events when issueNumber is null', () => {
    fc.assert(
      fc.property(eventWithoutIssueNumberArb, (event) => {
        const key = deriveQueueKey(event)
        expect(key).toBe(`${event.repo}:pr-${String((event as { prNumber: number }).prNumber)}`)
      }),
      { numRuns: 100 },
    )
  })

  it('key format is always {repo}:{issueNumber} or {repo}:pr-{prNumber}', () => {
    fc.assert(
      fc.property(anyFilteredEventArb, (event) => {
        const key = deriveQueueKey(event)
        // Key must contain exactly one colon separating repo from the identifier
        const colonIndex = key.indexOf(':')
        expect(colonIndex).toBeGreaterThan(0)

        const repoPrefix = key.slice(0, colonIndex)
        const suffix = key.slice(colonIndex + 1)

        expect(repoPrefix).toBe(event.repo)
        // Suffix is either a number (issue) or pr-{number}
        expect(suffix).toMatch(/^\d+$|^pr-\d+$/)
      }),
      { numRuns: 100 },
    )
  })
})

// ── Property 12: Job queue sequential invariant per key ──
// **Validates: Requirements 12.2, 12.3, 12.8**

describe('Property 12: Job queue sequential invariant per key', () => {
  it('at most one job is in-progress per key at any point in time', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 5 }),
        repoNameArb,
        issueNumberArb,
        async (jobCount, repo, issueNumber) => {
          const deferreds = Array.from({ length: jobCount }, () => deferred())
          let maxConcurrent = 0
          let currentConcurrent = 0

          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const processor = async (_job: { queueKey: string }): Promise<void> => {
            currentConcurrent++
            if (currentConcurrent > maxConcurrent) {
              maxConcurrent = currentConcurrent
            }
            // Wait for external resolution to control timing
            await deferreds[
              deferreds.findIndex((d) => {
                // Find the first unresolved deferred
                let resolved = false
                void d.promise.then(() => {
                  resolved = true
                })
                return !resolved
              }) % deferreds.length
            ].promise
            currentConcurrent--
          }

          const queue = createJobQueue(processor, mockLogger)

          // Enqueue all jobs with the same key
          const events: FilteredEvent[] = Array.from({ length: jobCount }, (_, i) => ({
            type: 'new_issue' as const,
            repo,
            issueNumber,
            issueTitle: `Test issue ${String(i)}`,
            issueBody: '',
          }))

          for (const event of events) {
            queue.enqueue(event)
          }

          // Resolve jobs one at a time and check concurrency
          for (let i = 0; i < jobCount; i++) {
            // At this point, exactly one job should be in-progress
            expect(currentConcurrent).toBeLessThanOrEqual(1)
            deferreds[i].resolve()
            // Allow microtasks to settle
            await new Promise((r) => setTimeout(r, 10))
          }

          expect(maxConcurrent).toBe(1)
        },
      ),
      { numRuns: 20 },
    )
  })

  it('next queued job starts immediately after current job completes', async () => {
    const d1 = deferred()
    const d2 = deferred()
    const startOrder: number[] = []
    let callIndex = 0

    const processor = async (): Promise<void> => {
      const myIndex = callIndex++
      startOrder.push(myIndex)
      if (myIndex === 0) {
        await d1.promise
      } else {
        await d2.promise
      }
    }

    const queue = createJobQueue(processor, mockLogger)

    const event1: FilteredEvent = {
      type: 'new_issue',
      repo: 'org/repo',
      issueNumber: 1,
      issueTitle: 'First',
      issueBody: '',
    }
    const event2: FilteredEvent = {
      type: 'follow_up_comment',
      repo: 'org/repo',
      issueNumber: 1,
      issueTitle: 'First',
      issueBody: '',
      commentBody: 'Follow up',
      commentId: 12345,
    }

    const job1 = queue.enqueue(event1)
    const job2 = queue.enqueue(event2)

    // Job 1 should be in-progress, job 2 should be queued
    expect(job1.status).toBe('in-progress')
    expect(job2.status).toBe('queued')

    // Complete job 1
    d1.resolve()
    await new Promise((r) => setTimeout(r, 20))

    // Job 1 should be completed, job 2 should now be in-progress
    expect(job1.status).toBe('completed')
    expect(job2.status).toBe('in-progress')

    // Complete job 2
    d2.resolve()
    await new Promise((r) => setTimeout(r, 20))

    expect(job2.status).toBe('completed')
    expect(startOrder).toEqual([0, 1])
  })

  it('next queued job starts immediately after current job fails', async () => {
    const d1 = deferred()
    const d2 = deferred()
    let callIndex = 0

    const processor = async (): Promise<void> => {
      const myIndex = callIndex++
      if (myIndex === 0) {
        await d1.promise
        throw new Error('Job 1 failed')
      } else {
        await d2.promise
      }
    }

    const queue = createJobQueue(processor, mockLogger)

    const event1: FilteredEvent = {
      type: 'new_issue',
      repo: 'org/repo',
      issueNumber: 42,
      issueTitle: 'Failing job',
      issueBody: '',
    }
    const event2: FilteredEvent = {
      type: 'follow_up_comment',
      repo: 'org/repo',
      issueNumber: 42,
      issueTitle: 'Failing job',
      issueBody: '',
      commentBody: 'Follow up',
      commentId: 12345,
    }

    const job1 = queue.enqueue(event1)
    const job2 = queue.enqueue(event2)

    expect(job1.status).toBe('in-progress')
    expect(job2.status).toBe('queued')

    // Fail job 1
    d1.resolve()
    await new Promise((r) => setTimeout(r, 20))

    // Job 1 should be failed, job 2 should now be in-progress
    expect(job1.status).toBe('failed')
    expect(job2.status).toBe('in-progress')

    // Complete job 2
    d2.resolve()
    await new Promise((r) => setTimeout(r, 20))

    expect(job2.status).toBe('completed')
  })

  it('sequential invariant holds for property-generated sequences', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 4 }), async (jobCount) => {
        const deferreds = Array.from({ length: jobCount }, () => deferred())
        const concurrencyLog: number[] = []
        let currentConcurrent = 0
        let jobIdx = 0

        const processor = async (): Promise<void> => {
          const myIdx = jobIdx++
          currentConcurrent++
          concurrencyLog.push(currentConcurrent)
          await deferreds[myIdx].promise
          currentConcurrent--
        }

        const queue = createJobQueue(processor, mockLogger)

        // All jobs share the same queue key
        for (let i = 0; i < jobCount; i++) {
          const event: FilteredEvent = {
            type: 'new_issue',
            repo: 'org/repo',
            issueNumber: 1,
            issueTitle: `Issue ${String(i)}`,
            issueBody: '',
          }
          queue.enqueue(event)
        }

        // Resolve each job sequentially
        for (let i = 0; i < jobCount; i++) {
          deferreds[i].resolve()
          await new Promise((r) => setTimeout(r, 15))
        }

        // Concurrency should never exceed 1 for the same key
        for (const c of concurrencyLog) {
          expect(c).toBeLessThanOrEqual(1)
        }
      }),
      { numRuns: 30 },
    )
  })
})

// ── Property 13: Job queue allows parallelism across different keys ──
// **Validates: Requirements 12.4, 12.5**

describe('Property 13: Job queue allows parallelism across different keys', () => {
  it('jobs with different keys can be in-progress simultaneously', async () => {
    const d1 = deferred()
    const d2 = deferred()
    const inProgressKeys = new Set<string>()
    let bothInProgress = false

    const processor = async (job: { queueKey: string }): Promise<void> => {
      inProgressKeys.add(job.queueKey)
      if (inProgressKeys.size >= 2) {
        bothInProgress = true
      }
      // Wait for external resolution
      if (job.queueKey === 'org/repo-a:1') {
        await d1.promise
      } else {
        await d2.promise
      }
      inProgressKeys.delete(job.queueKey)
    }

    const queue = createJobQueue(processor, mockLogger)

    const event1: FilteredEvent = {
      type: 'new_issue',
      repo: 'org/repo-a',
      issueNumber: 1,
      issueTitle: 'Issue A',
      issueBody: '',
    }
    const event2: FilteredEvent = {
      type: 'new_issue',
      repo: 'org/repo-b',
      issueNumber: 2,
      issueTitle: 'Issue B',
      issueBody: '',
    }

    const job1 = queue.enqueue(event1)
    const job2 = queue.enqueue(event2)

    // Both should be in-progress since they have different keys
    expect(job1.status).toBe('in-progress')
    expect(job2.status).toBe('in-progress')
    expect(bothInProgress).toBe(true)

    d1.resolve()
    d2.resolve()
    await new Promise((r) => setTimeout(r, 20))

    expect(job1.status).toBe('completed')
    expect(job2.status).toBe('completed')
  })

  it('jobs for different issues in the same repo run in parallel', async () => {
    const d1 = deferred()
    const d2 = deferred()
    const inProgressKeys = new Set<string>()
    let bothInProgress = false

    const processor = async (job: { queueKey: string }): Promise<void> => {
      inProgressKeys.add(job.queueKey)
      if (inProgressKeys.size >= 2) {
        bothInProgress = true
      }
      if (job.queueKey.endsWith(':10')) {
        await d1.promise
      } else {
        await d2.promise
      }
      inProgressKeys.delete(job.queueKey)
    }

    const queue = createJobQueue(processor, mockLogger)

    const event1: FilteredEvent = {
      type: 'new_issue',
      repo: 'org/repo',
      issueNumber: 10,
      issueTitle: 'Issue 10',
      issueBody: '',
    }
    const event2: FilteredEvent = {
      type: 'new_issue',
      repo: 'org/repo',
      issueNumber: 20,
      issueTitle: 'Issue 20',
      issueBody: '',
    }

    const job1 = queue.enqueue(event1)
    const job2 = queue.enqueue(event2)

    expect(job1.status).toBe('in-progress')
    expect(job2.status).toBe('in-progress')
    expect(bothInProgress).toBe(true)

    d1.resolve()
    d2.resolve()
    await new Promise((r) => setTimeout(r, 20))

    expect(job1.status).toBe('completed')
    expect(job2.status).toBe('completed')
  })

  it('property: any two events with different derived keys can run in parallel', async () => {
    await fc.assert(
      fc.asyncProperty(anyFilteredEventArb, anyFilteredEventArb, async (event1, event2) => {
        const key1 = deriveQueueKey(event1)
        const key2 = deriveQueueKey(event2)

        // Only test when keys are different
        fc.pre(key1 !== key2)

        const d1 = deferred()
        const d2 = deferred()
        const inProgressKeys = new Set<string>()
        let bothInProgress = false

        const processor = async (job: { queueKey: string }): Promise<void> => {
          inProgressKeys.add(job.queueKey)
          if (inProgressKeys.size >= 2) {
            bothInProgress = true
          }
          if (job.queueKey === key1) {
            await d1.promise
          } else {
            await d2.promise
          }
          inProgressKeys.delete(job.queueKey)
        }

        const queue = createJobQueue(processor, mockLogger)

        const job1 = queue.enqueue(event1)
        const job2 = queue.enqueue(event2)

        // Both should be in-progress simultaneously
        expect(job1.status).toBe('in-progress')
        expect(job2.status).toBe('in-progress')
        expect(bothInProgress).toBe(true)

        d1.resolve()
        d2.resolve()
        await new Promise((r) => setTimeout(r, 20))

        expect(job1.status).toBe('completed')
        expect(job2.status).toBe('completed')
      }),
      { numRuns: 100 },
    )
  })
})
