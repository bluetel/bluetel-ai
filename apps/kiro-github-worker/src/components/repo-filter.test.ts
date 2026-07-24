// Feature: kiro-github-worker, Property 4: Repo_Filter allowlist/denylist logic

import * as fc from 'fast-check'
import pino from 'pino'
import { describe, expect, it } from 'vitest'

import { createRepoFilter, type RepoFilterConfig } from './repo-filter.js'

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

/** Arbitrary that generates a non-empty set of unique repo names. */
const repoListArb = fc.uniqueArray(repoNameArb, { minLength: 1, maxLength: 10 })

// ── Property 4: Repo_Filter allowlist/denylist logic ──
// **Validates: Requirements 13.3, 13.4, 13.5, 13.6, 13.7**

describe('Property 4: Repo_Filter allowlist/denylist logic', () => {
  it('should accept all repos when neither allowlist nor denylist is configured', () => {
    fc.assert(
      fc.property(repoNameArb, (repoFullName) => {
        const config: RepoFilterConfig = { allowedRepos: null, deniedRepos: null }
        const filter = createRepoFilter(config, mockLogger)
        expect(filter(repoFullName)).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  it('should accept repo iff it is in the allowlist when only allowlist is configured', () => {
    fc.assert(
      fc.property(repoListArb, repoNameArb, (allowedRepos, repoFullName) => {
        const config: RepoFilterConfig = { allowedRepos, deniedRepos: null }
        const filter = createRepoFilter(config, mockLogger)
        const expected = allowedRepos.includes(repoFullName)
        expect(filter(repoFullName)).toBe(expected)
      }),
      { numRuns: 100 },
    )
  })

  it('should accept repo iff it is NOT in the denylist when only denylist is configured', () => {
    fc.assert(
      fc.property(repoListArb, repoNameArb, (deniedRepos, repoFullName) => {
        const config: RepoFilterConfig = { allowedRepos: null, deniedRepos }
        const filter = createRepoFilter(config, mockLogger)
        const expected = !deniedRepos.includes(repoFullName)
        expect(filter(repoFullName)).toBe(expected)
      }),
      { numRuns: 100 },
    )
  })

  it('should accept repo iff it is in allowlist AND not in denylist when both are configured', () => {
    fc.assert(
      fc.property(
        repoListArb,
        repoListArb,
        repoNameArb,
        (allowedRepos, deniedRepos, repoFullName) => {
          const config: RepoFilterConfig = { allowedRepos, deniedRepos }
          const filter = createRepoFilter(config, mockLogger)
          const expected =
            allowedRepos.includes(repoFullName) && !deniedRepos.includes(repoFullName)
          expect(filter(repoFullName)).toBe(expected)
        },
      ),
      { numRuns: 100 },
    )
  })

  // ── Targeted property: repo known to be in the allowlist is accepted ──

  it('should always accept a repo that is in the allowlist and not in the denylist', () => {
    fc.assert(
      fc.property(repoListArb, repoListArb, (allowedRepos, deniedRepos) => {
        // Pick a repo from the allowlist that is not in the denylist
        const candidate = allowedRepos.find((r) => !deniedRepos.includes(r))
        if (candidate == null) return // skip if all allowed repos are also denied

        const config: RepoFilterConfig = { allowedRepos, deniedRepos }
        const filter = createRepoFilter(config, mockLogger)
        expect(filter(candidate)).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  it('should always reject a repo that is in the denylist even if also in the allowlist', () => {
    fc.assert(
      fc.property(repoListArb, (repos) => {
        // Use the same list for both allow and deny — every repo is both allowed and denied
        const config: RepoFilterConfig = { allowedRepos: repos, deniedRepos: repos }
        const filter = createRepoFilter(config, mockLogger)
        for (const repo of repos) {
          expect(filter(repo)).toBe(false)
        }
      }),
      { numRuns: 100 },
    )
  })

  it('should always reject a repo not in the allowlist regardless of denylist', () => {
    fc.assert(
      fc.property(repoListArb, repoNameArb, (allowedRepos, repoFullName) => {
        fc.pre(!allowedRepos.includes(repoFullName))
        const config: RepoFilterConfig = { allowedRepos, deniedRepos: null }
        const filter = createRepoFilter(config, mockLogger)
        expect(filter(repoFullName)).toBe(false)
      }),
      { numRuns: 100 },
    )
  })

  // ── Example-based tests ──

  it('accepts "org/repo" when no filters configured', () => {
    const config: RepoFilterConfig = { allowedRepos: null, deniedRepos: null }
    const filter = createRepoFilter(config, mockLogger)
    expect(filter('org/repo')).toBe(true)
  })

  it('accepts "org/repo" when it is in the allowlist', () => {
    const config: RepoFilterConfig = { allowedRepos: ['org/repo', 'org/other'], deniedRepos: null }
    const filter = createRepoFilter(config, mockLogger)
    expect(filter('org/repo')).toBe(true)
  })

  it('rejects "org/repo" when it is not in the allowlist', () => {
    const config: RepoFilterConfig = { allowedRepos: ['org/other'], deniedRepos: null }
    const filter = createRepoFilter(config, mockLogger)
    expect(filter('org/repo')).toBe(false)
  })

  it('rejects "org/repo" when it is in the denylist', () => {
    const config: RepoFilterConfig = { allowedRepos: null, deniedRepos: ['org/repo'] }
    const filter = createRepoFilter(config, mockLogger)
    expect(filter('org/repo')).toBe(false)
  })

  it('accepts "org/repo" when it is not in the denylist', () => {
    const config: RepoFilterConfig = { allowedRepos: null, deniedRepos: ['org/other'] }
    const filter = createRepoFilter(config, mockLogger)
    expect(filter('org/repo')).toBe(true)
  })

  it('rejects "org/repo" when in allowlist but also in denylist (denylist wins)', () => {
    const config: RepoFilterConfig = { allowedRepos: ['org/repo'], deniedRepos: ['org/repo'] }
    const filter = createRepoFilter(config, mockLogger)
    expect(filter('org/repo')).toBe(false)
  })

  it('accepts "org/repo" when in allowlist and not in denylist', () => {
    const config: RepoFilterConfig = { allowedRepos: ['org/repo'], deniedRepos: ['org/other'] }
    const filter = createRepoFilter(config, mockLogger)
    expect(filter('org/repo')).toBe(true)
  })
})
