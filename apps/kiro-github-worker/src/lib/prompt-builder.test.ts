// Feature: kiro-github-worker, Property 16: Prompt construction includes all required context

import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  buildFollowUpPrompt,
  buildNewIssuePrompt,
  buildPRReviewPrompt,
  buildSetupPrompt,
} from './prompt-builder.js'

// ── Helpers ─────────────────────────────────────────────────────────

/** Arbitrary for non-empty strings (simulating titles, bodies, etc.). */
const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 200 })

/** Arbitrary for repo full names like "owner/repo". */
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

/** Arbitrary for branch names like "kiro/42-some-feature". */
const branchNameArb = fc
  .tuple(
    fc.constantFrom('kiro/', 'feature/', 'fix/'),
    fc.integer({ min: 1, max: 999999 }),
    fc.string({
      unit: fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', '-'),
      minLength: 1,
      maxLength: 20,
    }),
  )
  .map(([prefix, num, slug]) => `${prefix}${String(num)}-${slug}`)

// ── Property 16: Prompt construction includes all required context and git instructions ──
// **Validates: Requirements 4.1, 4.2, 7.3, 14.5, 14.8**

describe('Property 16: Prompt construction includes all required context and git instructions', () => {
  describe('buildNewIssuePrompt', () => {
    it('should contain the title, body, repo, issue number, and branch name', () => {
      fc.assert(
        fc.property(
          nonEmptyStringArb,
          nonEmptyStringArb,
          repoNameArb,
          issueNumberArb,
          branchNameArb,
          (title, body, repo, issueNumber, branchName) => {
            const prompt = buildNewIssuePrompt(title, body, repo, issueNumber, branchName)

            expect(prompt).toContain(title)
            expect(prompt).toContain(body)
            expect(prompt).toContain(repo)
            expect(prompt).toContain(String(issueNumber))
            expect(prompt).toContain(branchName)
          },
        ),
        { numRuns: 100 },
      )
    })

    it('should include commit, push, create-PR instructions and the branch name', () => {
      fc.assert(
        fc.property(
          nonEmptyStringArb,
          nonEmptyStringArb,
          repoNameArb,
          issueNumberArb,
          branchNameArb,
          (title, body, repo, issueNumber, branchName) => {
            const prompt = buildNewIssuePrompt(title, body, repo, issueNumber, branchName)
            const lower = prompt.toLowerCase()

            expect(lower).toContain('commit')
            expect(lower).toContain('push')
            expect(lower).toContain('pull request')
            expect(prompt).toContain(branchName)
          },
        ),
        { numRuns: 100 },
      )
    })
  })

  describe('buildFollowUpPrompt', () => {
    it('should contain the title, body, commentBody, repo, and issue number', () => {
      fc.assert(
        fc.property(
          nonEmptyStringArb,
          nonEmptyStringArb,
          nonEmptyStringArb,
          repoNameArb,
          issueNumberArb,
          (title, body, commentBody, repo, issueNumber) => {
            const prompt = buildFollowUpPrompt(title, body, commentBody, repo, issueNumber)

            expect(prompt).toContain(title)
            expect(prompt).toContain(body)
            expect(prompt).toContain(commentBody)
            expect(prompt).toContain(repo)
            expect(prompt).toContain(String(issueNumber))
          },
        ),
        { numRuns: 100 },
      )
    })

    it('should include commit and push instructions', () => {
      fc.assert(
        fc.property(
          nonEmptyStringArb,
          nonEmptyStringArb,
          nonEmptyStringArb,
          repoNameArb,
          issueNumberArb,
          (title, body, commentBody, repo, issueNumber) => {
            const prompt = buildFollowUpPrompt(title, body, commentBody, repo, issueNumber)
            const lower = prompt.toLowerCase()

            expect(lower).toContain('commit')
            expect(lower).toContain('push')
          },
        ),
        { numRuns: 100 },
      )
    })
  })

  describe('buildPRReviewPrompt', () => {
    it('should contain the title, body, feedback, repo, issue number, and PR number', () => {
      fc.assert(
        fc.property(
          nonEmptyStringArb,
          nonEmptyStringArb,
          nonEmptyStringArb,
          repoNameArb,
          issueNumberArb,
          issueNumberArb,
          (title, body, feedback, repo, issueNumber, prNumber) => {
            const prompt = buildPRReviewPrompt(title, body, feedback, repo, issueNumber, prNumber)

            expect(prompt).toContain(title)
            expect(prompt).toContain(body)
            expect(prompt).toContain(feedback)
            expect(prompt).toContain(repo)
            expect(prompt).toContain(String(issueNumber))
            expect(prompt).toContain(String(prNumber))
          },
        ),
        { numRuns: 100 },
      )
    })

    it('should include commit, push, and reply comment instructions', () => {
      fc.assert(
        fc.property(
          nonEmptyStringArb,
          nonEmptyStringArb,
          nonEmptyStringArb,
          repoNameArb,
          issueNumberArb,
          issueNumberArb,
          (title, body, feedback, repo, issueNumber, prNumber) => {
            const prompt = buildPRReviewPrompt(title, body, feedback, repo, issueNumber, prNumber)
            const lower = prompt.toLowerCase()

            expect(lower).toContain('commit')
            expect(lower).toContain('push')
            expect(lower).toContain('reply comment')
          },
        ),
        { numRuns: 100 },
      )
    })
  })
})

// ── Feature: auto-dependency-install, Property 1: No-commit constraints ──
// **Validates: Requirements 1.7**

describe('Property 1: Setup prompt contains no-commit constraints', () => {
  it('should contain prohibitive language for commit, push, and PR creation', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const prompt = buildSetupPrompt()

        expect(prompt).toContain('Do NOT commit')
        expect(prompt).toContain('Do NOT push')
        expect(prompt).toContain('Do NOT create pull requests')
      }),
      { numRuns: 100 },
    )
  })
})

// ── Feature: auto-dependency-install, Property 2: Multiple language ecosystems ──
// **Validates: Requirements 1.3, 1.4, 1.5**

describe('Property 2: Setup prompt covers multiple language ecosystems', () => {
  it('should reference JavaScript/TypeScript, Python, Go, and Rust ecosystems', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const prompt = buildSetupPrompt()
        const lower = prompt.toLowerCase()

        // JavaScript/TypeScript ecosystem
        expect(lower).toContain('javascript')
        expect(lower).toContain('typescript')

        // Python ecosystem
        expect(lower).toContain('python')

        // Go ecosystem
        expect(lower).toContain('go')
        expect(prompt).toContain('go.mod')

        // Rust ecosystem
        expect(lower).toContain('rust')
        expect(prompt).toContain('Cargo.toml')
      }),
      { numRuns: 100 },
    )
  })
})

// ── Feature: auto-dependency-install, Property 3: Lockfile priority order for JS/TS ──
// **Validates: Requirements 1.3**

describe('Property 3: Setup prompt includes lockfile priority order for JS/TS', () => {
  it('should list lockfiles in correct priority order: pnpm-lock.yaml → yarn.lock → bun.lockb/bun.lock → package-lock.json', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const prompt = buildSetupPrompt()

        const pnpmIdx = prompt.indexOf('pnpm-lock.yaml')
        const yarnIdx = prompt.indexOf('yarn.lock')
        const bunIdx = Math.min(
          ...[prompt.indexOf('bun.lockb'), prompt.indexOf('bun.lock')].filter((i) => i !== -1),
        )
        const npmIdx = prompt.indexOf('package-lock.json')

        // All lockfiles must be present
        expect(pnpmIdx).toBeGreaterThan(-1)
        expect(yarnIdx).toBeGreaterThan(-1)
        expect(bunIdx).toBeGreaterThan(-1)
        expect(npmIdx).toBeGreaterThan(-1)

        // Priority order: pnpm → yarn → bun → npm
        expect(pnpmIdx).toBeLessThan(yarnIdx)
        expect(yarnIdx).toBeLessThan(bunIdx)
        expect(bunIdx).toBeLessThan(npmIdx)
      }),
      { numRuns: 100 },
    )
  })
})

// ── Unit tests for buildSetupPrompt ──
// _Requirements: 1.1, 1.6, 1.8_

describe('buildSetupPrompt unit tests', () => {
  it('should return a non-empty string', () => {
    const prompt = buildSetupPrompt()
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(0)
  })

  it('should mention README and Makefile inspection', () => {
    const prompt = buildSetupPrompt()
    expect(prompt).toContain('README')
    expect(prompt).toContain('Makefile')
  })

  it('should include skip-if-nothing behavior', () => {
    const prompt = buildSetupPrompt()
    expect(prompt).toContain('exit successfully without error')
  })
})
