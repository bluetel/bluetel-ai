// Feature: kiro-github-worker, Property 15: All posted comments contain the rocky-worker marker

import type { Octokit } from '@octokit/rest'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { COMMENT_MARKER } from '../lib/types.js'

import {
  postConflict,
  postError,
  postPRFeedbackAck,
  postPRFeedbackError,
  postQueued,
  postSuccess,
  postUpdated,
} from './issue-commenter.js'

// ── Helpers ─────────────────────────────────────────────────────────

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

/** Arbitrary for positive issue/PR numbers. */
const issueNumberArb = fc.integer({ min: 1, max: 999999 })

/** Arbitrary for non-empty strings (used for prUrl, commitSha, step, error). */
const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 200 })

/** Arbitrary for queue positions (1-based). */
const positionArb = fc.integer({ min: 1, max: 100 })

/**
 * Creates a mock Octokit that captures the comment body passed to
 * `issues.createComment` and returns it for assertion.
 */
const createCapturingOctokit = (): { octokit: Octokit; getCapturedBodies: () => string[] } => {
  const capturedBodies: string[] = []

  const octokit = {
    issues: {
      createComment: (params: {
        owner: string
        repo: string
        issue_number: number
        body: string
      }) => {
        capturedBodies.push(params.body)
        return Promise.resolve({ data: { id: 1 } })
      },
    },
  } as unknown as Octokit

  return { octokit, getCapturedBodies: () => capturedBodies }
}

// ── Property 15: All posted comments contain the rocky-worker marker ──
// **Validates: Requirements 6.4, 18.6**

describe('Property 15: All posted comments contain the rocky-worker marker', () => {
  it('postSuccess comments start with the rocky-worker marker', async () => {
    await fc.assert(
      fc.asyncProperty(
        repoNameArb,
        issueNumberArb,
        nonEmptyStringArb,
        async (repo, issueNumber, prUrl) => {
          const { octokit, getCapturedBodies } = createCapturingOctokit()
          await postSuccess(octokit, repo, issueNumber, prUrl)
          const bodies = getCapturedBodies()
          expect(bodies).toHaveLength(1)
          expect(bodies[0].startsWith(COMMENT_MARKER)).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('postUpdated comments start with the rocky-worker marker', async () => {
    await fc.assert(
      fc.asyncProperty(
        repoNameArb,
        issueNumberArb,
        nonEmptyStringArb,
        async (repo, issueNumber, commitSha) => {
          const { octokit, getCapturedBodies } = createCapturingOctokit()
          await postUpdated(octokit, repo, issueNumber, commitSha)
          const bodies = getCapturedBodies()
          expect(bodies).toHaveLength(1)
          expect(bodies[0].startsWith(COMMENT_MARKER)).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('postError comments start with the rocky-worker marker', async () => {
    await fc.assert(
      fc.asyncProperty(
        repoNameArb,
        issueNumberArb,
        nonEmptyStringArb,
        nonEmptyStringArb,
        async (repo, issueNumber, step, error) => {
          const { octokit, getCapturedBodies } = createCapturingOctokit()
          await postError(octokit, repo, issueNumber, step, error)
          const bodies = getCapturedBodies()
          expect(bodies).toHaveLength(1)
          expect(bodies[0].startsWith(COMMENT_MARKER)).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('postQueued comments start with the rocky-worker marker', async () => {
    await fc.assert(
      fc.asyncProperty(
        repoNameArb,
        issueNumberArb,
        positionArb,
        async (repo, issueNumber, position) => {
          const { octokit, getCapturedBodies } = createCapturingOctokit()
          await postQueued(octokit, repo, issueNumber, position)
          const bodies = getCapturedBodies()
          expect(bodies).toHaveLength(1)
          expect(bodies[0].startsWith(COMMENT_MARKER)).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('postConflict comments start with the rocky-worker marker', async () => {
    await fc.assert(
      fc.asyncProperty(repoNameArb, issueNumberArb, async (repo, issueNumber) => {
        const { octokit, getCapturedBodies } = createCapturingOctokit()
        await postConflict(octokit, repo, issueNumber)
        const bodies = getCapturedBodies()
        expect(bodies).toHaveLength(1)
        expect(bodies[0].startsWith(COMMENT_MARKER)).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  it('postPRFeedbackAck comments start with the rocky-worker marker', async () => {
    await fc.assert(
      fc.asyncProperty(
        repoNameArb,
        issueNumberArb,
        nonEmptyStringArb,
        async (repo, prNumber, commitSha) => {
          const { octokit, getCapturedBodies } = createCapturingOctokit()
          await postPRFeedbackAck(octokit, repo, prNumber, commitSha)
          const bodies = getCapturedBodies()
          expect(bodies).toHaveLength(1)
          expect(bodies[0].startsWith(COMMENT_MARKER)).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('postPRFeedbackError comments start with the rocky-worker marker', async () => {
    await fc.assert(
      fc.asyncProperty(
        repoNameArb,
        issueNumberArb,
        nonEmptyStringArb,
        async (repo, prNumber, error) => {
          const { octokit, getCapturedBodies } = createCapturingOctokit()
          await postPRFeedbackError(octokit, repo, prNumber, error)
          const bodies = getCapturedBodies()
          expect(bodies).toHaveLength(1)
          expect(bodies[0].startsWith(COMMENT_MARKER)).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })
})
