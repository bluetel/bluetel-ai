// Feature: kiro-github-worker, Property 7: Branch template validation rejects invalid Git branch names
// Feature: kiro-github-worker, Property 8: Branch template rendering produces correct substitutions with valid slugs
// Feature: kiro-github-worker, Property 9: Rendered branch names never exceed 255 characters

import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { renderBranchName, slugify, validateTemplate } from './branch-template'

// ── Helpers ─────────────────────────────────────────────────────────

/** Arbitrary that generates ASCII control characters (0x00-0x1F, 0x7F). */
const controlCharArb = fc.mapToConstant(
  { num: 32, build: (v) => String.fromCharCode(v) }, // 0x00-0x1F
  { num: 1, build: () => String.fromCharCode(0x7f) }, // 0x7F
)

/** Arbitrary that generates valid branch template prefixes (no invalid chars). */
const safePrefixArb = fc.string({
  unit: fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', '/', '-', '_', '1', '2', '3'),
  minLength: 1,
  maxLength: 15,
})

/** Arbitrary that generates valid branch templates containing placeholders. */
const validTemplateArb = fc
  .tuple(safePrefixArb, fc.constantFrom('/', '-', '_'))
  .map(([prefix, sep]) => `${prefix}${sep}{issue_number}${sep}{slug}`)

/** Arbitrary for positive issue numbers. */
const issueNumberArb = fc.integer({ min: 1, max: 999_999 })

/** Arbitrary for non-empty issue titles with varied characters. */
const issueTitleArb = fc.string({
  unit: fc.constantFrom(
    'a',
    'b',
    'c',
    'A',
    'B',
    'C',
    '1',
    '2',
    '3',
    ' ',
    '-',
    '_',
    '.',
    '!',
    '@',
    '#',
    '$',
    '%',
    'é',
    'ñ',
    '中',
    '日',
  ),
  minLength: 1,
  maxLength: 200,
})

/** Arbitrary for optional PR numbers. */
const optionalPrNumberArb = fc.option(fc.integer({ min: 1, max: 999_999 }), { nil: undefined })

// ── Property 7: Branch template validation rejects invalid Git branch names ──
// **Validates: Requirements 8.9, 15.5**

describe('Property 7: Branch template validation rejects invalid Git branch names', () => {
  it('should reject templates containing spaces', () => {
    const templateWithSpaceArb = fc
      .tuple(safePrefixArb, safePrefixArb)
      .map(([before, after]) => `${before} ${after}`)

    fc.assert(
      fc.property(templateWithSpaceArb, (template) => {
        const result = validateTemplate(template)
        expect(result.valid).toBe(false)
        expect(result.warnings.some((w) => w.toLowerCase().includes('space'))).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  it('should reject templates containing ".."', () => {
    const templateWithDotsArb = fc
      .tuple(safePrefixArb, safePrefixArb)
      .map(([before, after]) => `${before}..${after}`)

    fc.assert(
      fc.property(templateWithDotsArb, (template) => {
        const result = validateTemplate(template)
        expect(result.valid).toBe(false)
        expect(result.warnings.some((w) => w.includes('..'))).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  it('should reject templates ending with ".lock"', () => {
    const templateWithLockArb = safePrefixArb.map((prefix) => `${prefix}.lock`)

    fc.assert(
      fc.property(templateWithLockArb, (template) => {
        const result = validateTemplate(template)
        expect(result.valid).toBe(false)
        expect(result.warnings.some((w) => w.toLowerCase().includes('.lock'))).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  it('should reject templates containing ASCII control characters', () => {
    const templateWithControlArb = fc
      .tuple(safePrefixArb, controlCharArb, safePrefixArb)
      .map(([before, ctrl, after]) => `${before}${ctrl}${after}`)

    fc.assert(
      fc.property(templateWithControlArb, (template) => {
        const result = validateTemplate(template)
        expect(result.valid).toBe(false)
        expect(result.warnings.some((w) => w.toLowerCase().includes('control'))).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  it('should accept valid templates without invalid patterns', () => {
    fc.assert(
      fc.property(validTemplateArb, (template) => {
        const result = validateTemplate(template)
        expect(result.valid).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  // Example-based tests
  it('rejects "feature branch/{slug}" (contains space)', () => {
    const result = validateTemplate('feature branch/{slug}')
    expect(result.valid).toBe(false)
  })

  it('rejects "feature/../{slug}" (contains "..")', () => {
    const result = validateTemplate('feature/../{slug}')
    expect(result.valid).toBe(false)
  })

  it('rejects "feature/{slug}.lock" (ends with ".lock")', () => {
    const result = validateTemplate('feature/{slug}.lock')
    expect(result.valid).toBe(false)
  })

  it('rejects template with null byte', () => {
    const result = validateTemplate('feature/\x00{slug}')
    expect(result.valid).toBe(false)
  })

  it('accepts "{issue_number}-{slug}"', () => {
    const result = validateTemplate('{issue_number}-{slug}')
    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it('warns when template lacks {issue_number}', () => {
    const result = validateTemplate('feature/{slug}')
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.includes('{issue_number}'))).toBe(true)
  })
})

// ── Property 8: Branch template rendering produces correct substitutions with valid slugs ──
// **Validates: Requirements 15.1, 15.2**

describe('Property 8: Branch template rendering produces correct substitutions with valid slugs', () => {
  it('should produce correct substitutions for any valid template, issue number, title, and optional PR number', () => {
    const templateWithAllPlaceholdersArb = safePrefixArb.map(
      (prefix) => `${prefix}/{issue_number}-{slug}-pr{pr_number}`,
    )

    fc.assert(
      fc.property(
        templateWithAllPlaceholdersArb,
        issueNumberArb,
        issueTitleArb,
        optionalPrNumberArb,
        (template, issueNumber, issueTitle, prNumber) => {
          const result = renderBranchName(template, {
            issueNumber,
            issueTitle,
            prNumber,
          })

          // Should contain the issue number
          expect(result).toContain(String(issueNumber))

          // The slug portion should be valid
          const slug = slugify(issueTitle)
          if (slug.length > 0) {
            // Slug is lowercase
            expect(slug).toBe(slug.toLowerCase())
            // Slug contains only [a-z0-9-]
            expect(slug).toMatch(/^[a-z0-9-]*$/)
            // No consecutive hyphens
            expect(slug).not.toMatch(/--/)
            // No leading or trailing hyphens
            expect(slug).not.toMatch(/^-/)
            expect(slug).not.toMatch(/-$/)
          }

          // Should contain PR number when provided
          if (prNumber != null) {
            expect(result).toContain(String(prNumber))
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('should correctly substitute {issue_number} placeholder', () => {
    fc.assert(
      fc.property(issueNumberArb, (issueNumber) => {
        const result = renderBranchName('feature/{issue_number}', {
          issueNumber,
          issueTitle: 'test title',
        })
        expect(result).toBe(`feature/${issueNumber}`)
      }),
      { numRuns: 100 },
    )
  })

  it('should produce slugs that are always lowercase with only [a-z0-9-]', () => {
    fc.assert(
      fc.property(issueTitleArb, (title) => {
        const slug = slugify(title)
        if (slug.length > 0) {
          expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
        }
      }),
      { numRuns: 100 },
    )
  })

  // Example-based tests
  it('renders "{issue_number}-{slug}" with issue 42 and title "Fix login bug"', () => {
    const result = renderBranchName('{issue_number}-{slug}', {
      issueNumber: 42,
      issueTitle: 'Fix login bug',
    })
    expect(result).toBe('42-fix-login-bug')
  })

  it('renders template with PR number', () => {
    const result = renderBranchName('feat/{issue_number}-{slug}-pr{pr_number}', {
      issueNumber: 10,
      issueTitle: 'Add feature',
      prNumber: 55,
    })
    expect(result).toBe('feat/10-add-feature-pr55')
  })

  it('renders template without PR number (empty string)', () => {
    const result = renderBranchName('feat/{issue_number}-{slug}-pr{pr_number}', {
      issueNumber: 10,
      issueTitle: 'Add feature',
    })
    expect(result).toBe('feat/10-add-feature-pr')
  })

  it('slugifies special characters correctly', () => {
    expect(slugify('Hello World!!!')).toBe('hello-world')
    expect(slugify('---leading-trailing---')).toBe('leading-trailing')
    expect(slugify('UPPERCASE TITLE')).toBe('uppercase-title')
    expect(slugify('multiple   spaces   here')).toBe('multiple-spaces-here')
  })
})

// ── Property 9: Rendered branch names never exceed 255 characters ──
// **Validates: Requirements 15.3**

describe('Property 9: Rendered branch names never exceed 255 characters', () => {
  it('should never exceed 255 characters for any valid template and any issue title', () => {
    // Use titles of arbitrary length, including very long ones
    const longTitleArb = fc.string({
      unit: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', ' ', '-', '1', '2'),
      minLength: 1,
      maxLength: 500,
    })

    fc.assert(
      fc.property(
        validTemplateArb,
        issueNumberArb,
        longTitleArb,
        optionalPrNumberArb,
        (template, issueNumber, issueTitle, prNumber) => {
          const result = renderBranchName(template, {
            issueNumber,
            issueTitle,
            prNumber,
          })
          expect(result.length).toBeLessThanOrEqual(255)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('should truncate slug for extremely long titles', () => {
    const veryLongTitle = 'a'.repeat(500)
    const result = renderBranchName('{issue_number}-{slug}', {
      issueNumber: 1,
      issueTitle: veryLongTitle,
    })
    expect(result.length).toBeLessThanOrEqual(255)
    expect(result.startsWith('1-')).toBe(true)
  })

  it('should handle templates with multiple slug placeholders within 255 chars', () => {
    const longTitle = 'word '.repeat(100)
    const result = renderBranchName('{slug}-{issue_number}-{slug}', {
      issueNumber: 42,
      issueTitle: longTitle,
    })
    expect(result.length).toBeLessThanOrEqual(255)
    expect(result).toContain('42')
  })

  it('should handle template with no slug placeholder (no truncation needed)', () => {
    const result = renderBranchName('feature/{issue_number}', {
      issueNumber: 12345,
      issueTitle: 'a'.repeat(500),
    })
    expect(result).toBe('feature/12345')
  })

  it('should not leave trailing hyphens after slug truncation', () => {
    // Create a title that produces a slug with hyphens at truncation boundary
    const title = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 'a' : ' ')).join('')
    const result = renderBranchName('{issue_number}-{slug}', {
      issueNumber: 1,
      issueTitle: title,
    })
    expect(result.length).toBeLessThanOrEqual(255)
    expect(result).not.toMatch(/-$/)
  })
})
