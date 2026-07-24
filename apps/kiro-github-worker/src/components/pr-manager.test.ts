// Feature: kiro-github-worker, Property 14: PR title and body contain required elements

import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { buildNewIssuePrompt } from '../lib/prompt-builder'

import { formatPRBody, formatPRTitle } from './pr-manager'

// ── Arbitraries ─────────────────────────────────────────────────────

/** Arbitrary that generates realistic issue titles (non-empty strings). */
const issueTitleArb = fc.string({ minLength: 1, maxLength: 200 })

/** Arbitrary that generates positive issue numbers. */
const issueNumberArb = fc.integer({ min: 1, max: 999_999 })

/** Arbitrary for non-empty issue body text. */
const issueBodyArb = fc.string({ minLength: 0, maxLength: 300 })

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

/** Arbitrary for branch names like "kiro/42-some-feature". */
const branchNameArb = fc
  .tuple(
    fc.constantFrom('kiro/', 'feature/', 'fix/'),
    fc.integer({ min: 1, max: 999_999 }),
    fc.string({
      unit: fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', '-'),
      minLength: 1,
      maxLength: 20,
    }),
  )
  .map(([prefix, num, slug]) => `${prefix}${String(num)}-${slug}`)

// ── Property 14: PR title and body contain required elements ──
// **Validates: Requirements 5.3**

describe('Property 14: PR title and body contain required elements', () => {
  it('PR title matches [Kiro] {issueTitle} for any issue title', () => {
    fc.assert(
      fc.property(issueTitleArb, (issueTitle) => {
        const title = formatPRTitle(issueTitle)
        expect(title).toBe(`[Kiro] ${issueTitle}`)
      }),
      { numRuns: 100 },
    )
  })

  it('PR title always starts with the [Kiro] prefix', () => {
    fc.assert(
      fc.property(issueTitleArb, (issueTitle) => {
        const title = formatPRTitle(issueTitle)
        expect(title.startsWith('[Kiro] ')).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  it('PR title preserves the full issue title after the prefix', () => {
    fc.assert(
      fc.property(issueTitleArb, (issueTitle) => {
        const title = formatPRTitle(issueTitle)
        expect(title.slice('[Kiro] '.length)).toBe(issueTitle)
      }),
      { numRuns: 100 },
    )
  })

  it('PR body contains Closes #{issueNumber} for any issue number', () => {
    fc.assert(
      fc.property(issueNumberArb, (issueNumber) => {
        const body = formatPRBody(issueNumber)
        expect(body).toContain(`Closes #${String(issueNumber)}`)
      }),
      { numRuns: 100 },
    )
  })

  it('PR title and body contain required elements for any issue number and title combination', () => {
    fc.assert(
      fc.property(issueNumberArb, issueTitleArb, (issueNumber, issueTitle) => {
        const title = formatPRTitle(issueTitle)
        const body = formatPRBody(issueNumber)

        // Title matches [Kiro] {issueTitle}
        expect(title).toBe(`[Kiro] ${issueTitle}`)

        // Body contains Closes #{issueNumber}
        expect(body).toContain(`Closes #${String(issueNumber)}`)
      }),
      { numRuns: 100 },
    )
  })

  it('new-issue prompt contains [Kiro] {issueTitle} instruction text', () => {
    fc.assert(
      fc.property(
        issueTitleArb,
        issueBodyArb,
        repoNameArb,
        issueNumberArb,
        branchNameArb,
        (issueTitle, issueBody, repo, issueNumber, branchName) => {
          const prompt = buildNewIssuePrompt(issueTitle, issueBody, repo, issueNumber, branchName)
          expect(prompt).toContain(`[Kiro] ${issueTitle}`)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('new-issue prompt contains Closes #{issueNumber} instruction text', () => {
    fc.assert(
      fc.property(
        issueTitleArb,
        issueBodyArb,
        repoNameArb,
        issueNumberArb,
        branchNameArb,
        (issueTitle, issueBody, repo, issueNumber, branchName) => {
          const prompt = buildNewIssuePrompt(issueTitle, issueBody, repo, issueNumber, branchName)
          expect(prompt).toContain(`Closes #${String(issueNumber)}`)
        },
      ),
      { numRuns: 100 },
    )
  })
})
