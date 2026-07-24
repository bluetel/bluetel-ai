// Feature: kiro-github-worker, Property 17: Working directory paths are unique per repo/issue pair

import * as fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildWorkingDirPath } from './repo-cloner.js'

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

/** Arbitrary that generates positive issue numbers. */
const issueNumberArb = fc.integer({ min: 1, max: 100_000 })

/** Arbitrary for a working directory base path. */
const baseDirArb = fc.constantFrom('/tmp', '/var/tmp', '/home/user/work')

// ── Property 17: Working directory paths are unique per repo/issue pair ──
// **Validates: Requirements 13.8**

describe('Property 17: Working directory paths are unique per repo/issue pair', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('different repo names produce different paths at the same timestamp', () => {
    fc.assert(
      fc.property(
        baseDirArb,
        repoNameArb,
        repoNameArb,
        issueNumberArb,
        (baseDir, repoA, repoB, issueNumber) => {
          fc.pre(repoA !== repoB)

          // Fix timestamp so only the repo/issue pair determines uniqueness
          vi.spyOn(Date, 'now').mockReturnValue(1_000_000)

          const pathA = buildWorkingDirPath(baseDir, repoA, issueNumber)
          const pathB = buildWorkingDirPath(baseDir, repoB, issueNumber)

          expect(pathA).not.toBe(pathB)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('different issue numbers produce different paths at the same timestamp', () => {
    fc.assert(
      fc.property(
        baseDirArb,
        repoNameArb,
        issueNumberArb,
        issueNumberArb,
        (baseDir, repo, issueA, issueB) => {
          fc.pre(issueA !== issueB)

          vi.spyOn(Date, 'now').mockReturnValue(1_000_000)

          const pathA = buildWorkingDirPath(baseDir, repo, issueA)
          const pathB = buildWorkingDirPath(baseDir, repo, issueB)

          expect(pathA).not.toBe(pathB)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('distinct (repo, issue) pairs always produce different paths at the same timestamp', () => {
    fc.assert(
      fc.property(
        baseDirArb,
        repoNameArb,
        issueNumberArb,
        repoNameArb,
        issueNumberArb,
        (baseDir, repoA, issueA, repoB, issueB) => {
          fc.pre(repoA !== repoB || issueA !== issueB)

          vi.spyOn(Date, 'now').mockReturnValue(1_000_000)

          const pathA = buildWorkingDirPath(baseDir, repoA, issueA)
          const pathB = buildWorkingDirPath(baseDir, repoB, issueB)

          expect(pathA).not.toBe(pathB)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('path contains the repo name (with / replaced by -) and issue number', () => {
    fc.assert(
      fc.property(baseDirArb, repoNameArb, issueNumberArb, (baseDir, repo, issueNumber) => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000_000)

        const path = buildWorkingDirPath(baseDir, repo, issueNumber)
        const safeRepo = repo.replace(/\//g, '-')

        expect(path).toContain(safeRepo)
        expect(path).toContain(String(issueNumber))
        expect(path).toMatch(
          new RegExp(`^${baseDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/rocky-`),
        )
      }),
      { numRuns: 100 },
    )
  })
})
