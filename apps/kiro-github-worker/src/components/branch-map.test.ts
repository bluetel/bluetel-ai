// Feature: kiro-github-worker, Property 10: Branch_Map get/set round-trip consistency

import * as fc from 'fast-check'
import pino from 'pino'
import { describe, expect, it } from 'vitest'

import { createBranchMap } from './branch-map.js'

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

/** Arbitrary that generates positive issue numbers. */
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

/** Arbitrary for a single set operation: { repo, issueNumber, branchName }. */
const setOpArb = fc.record({
  repo: repoNameArb,
  issueNumber: issueNumberArb,
  branchName: branchNameArb,
})

// ── Property 10: Branch_Map get/set round-trip consistency ──
// **Validates: Requirements 16.1**

describe('Property 10: Branch_Map get/set round-trip consistency', () => {
  it('get returns the branch name after a single set', () => {
    fc.assert(
      fc.property(repoNameArb, issueNumberArb, branchNameArb, (repo, issueNumber, branchName) => {
        const branchMap = createBranchMap('test-bot', mockLogger)
        branchMap.set(repo, issueNumber, branchName)
        expect(branchMap.get(repo, issueNumber)).toBe(branchName)
      }),
      { numRuns: 100 },
    )
  })

  it('findByBranch returns the issue number after a single set', () => {
    fc.assert(
      fc.property(repoNameArb, issueNumberArb, branchNameArb, (repo, issueNumber, branchName) => {
        const branchMap = createBranchMap('test-bot', mockLogger)
        branchMap.set(repo, issueNumber, branchName)
        expect(branchMap.findByBranch(repo, branchName)).toBe(issueNumber)
      }),
      { numRuns: 100 },
    )
  })

  it('get returns the most recently set branch name for a repo/issue pair', () => {
    fc.assert(
      fc.property(
        repoNameArb,
        issueNumberArb,
        branchNameArb,
        branchNameArb,
        (repo, issueNumber, firstBranch, secondBranch) => {
          const branchMap = createBranchMap('test-bot', mockLogger)
          branchMap.set(repo, issueNumber, firstBranch)
          branchMap.set(repo, issueNumber, secondBranch)
          expect(branchMap.get(repo, issueNumber)).toBe(secondBranch)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('findByBranch returns the issue number for the most recently set branch', () => {
    fc.assert(
      fc.property(
        repoNameArb,
        issueNumberArb,
        branchNameArb,
        branchNameArb,
        (repo, issueNumber, firstBranch, secondBranch) => {
          const branchMap = createBranchMap('test-bot', mockLogger)
          branchMap.set(repo, issueNumber, firstBranch)
          branchMap.set(repo, issueNumber, secondBranch)
          expect(branchMap.findByBranch(repo, secondBranch)).toBe(issueNumber)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('get/set round-trip is consistent across a sequence of set operations', () => {
    fc.assert(
      fc.property(fc.array(setOpArb, { minLength: 1, maxLength: 30 }), (operations) => {
        const branchMap = createBranchMap('test-bot', mockLogger)

        // Apply all set operations
        for (const op of operations) {
          branchMap.set(op.repo, op.issueNumber, op.branchName)
        }

        // Build expected state: last write wins per (repo, issueNumber)
        const expected = new Map<string, Map<number, string>>()
        for (const op of operations) {
          let repoMap = expected.get(op.repo)
          if (repoMap == null) {
            repoMap = new Map()
            expected.set(op.repo, repoMap)
          }
          repoMap.set(op.issueNumber, op.branchName)
        }

        // Verify get returns the most recently set branch for each repo/issue pair
        for (const [repo, issueMap] of expected) {
          for (const [issueNumber, branchName] of issueMap) {
            expect(branchMap.get(repo, issueNumber)).toBe(branchName)
          }
        }
      }),
      { numRuns: 100 },
    )
  })

  it('findByBranch is consistent across a sequence of set operations', () => {
    fc.assert(
      fc.property(fc.array(setOpArb, { minLength: 1, maxLength: 30 }), (operations) => {
        const branchMap = createBranchMap('test-bot', mockLogger)

        // Apply all set operations
        for (const op of operations) {
          branchMap.set(op.repo, op.issueNumber, op.branchName)
        }

        // Build expected secondary index: last write wins per (repo, branchName)
        const expectedByBranch = new Map<string, Map<string, number>>()
        for (const op of operations) {
          let repoMap = expectedByBranch.get(op.repo)
          if (repoMap == null) {
            repoMap = new Map()
            expectedByBranch.set(op.repo, repoMap)
          }
          repoMap.set(op.branchName, op.issueNumber)
        }

        // Verify findByBranch returns the correct issue number
        for (const [repo, branchIssueMap] of expectedByBranch) {
          for (const [branchName, issueNumber] of branchIssueMap) {
            expect(branchMap.findByBranch(repo, branchName)).toBe(issueNumber)
          }
        }
      }),
      { numRuns: 100 },
    )
  })

  it('get returns undefined for repo/issue pairs that were never set', () => {
    fc.assert(
      fc.property(
        repoNameArb,
        issueNumberArb,
        repoNameArb,
        issueNumberArb,
        branchNameArb,
        (setRepo, setIssue, queryRepo, queryIssue, branchName) => {
          fc.pre(setRepo !== queryRepo || setIssue !== queryIssue)
          const branchMap = createBranchMap('test-bot', mockLogger)
          branchMap.set(setRepo, setIssue, branchName)
          expect(branchMap.get(queryRepo, queryIssue)).toBeUndefined()
        },
      ),
      { numRuns: 100 },
    )
  })

  it('findByBranch returns undefined for branches that were never set', () => {
    fc.assert(
      fc.property(
        repoNameArb,
        issueNumberArb,
        branchNameArb,
        repoNameArb,
        branchNameArb,
        (setRepo, setIssue, setBranch, queryRepo, queryBranch) => {
          fc.pre(setRepo !== queryRepo || setBranch !== queryBranch)
          const branchMap = createBranchMap('test-bot', mockLogger)
          branchMap.set(setRepo, setIssue, setBranch)
          expect(branchMap.findByBranch(queryRepo, queryBranch)).toBeUndefined()
        },
      ),
      { numRuns: 100 },
    )
  })
})
