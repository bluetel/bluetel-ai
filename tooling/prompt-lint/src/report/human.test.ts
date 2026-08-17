import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildConfig } from '../config'
import type { Report } from '../gate'
import type { Finding, RuleId } from '../rules'

import { renderHuman, renderRuleExplanation, renderRuleList } from './human'

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  rule: 'refs/dangling-path' as RuleId,
  severity: 'error',
  path: 'tooling/skills/catalog/copywriting/references/natural-transitions.md',
  line: 276,
  message: 'References `references/ai-writing-detection.md`, which does not exist.',
  remediation: 'Point at an existing reference, or remove the sentence.',
  ...overrides,
})

const report = (overrides: Partial<Report> = {}): Report => ({
  verdict: 'fail',
  scope: {
    mode: 'diff',
    baseRef: 'origin/main',
    artifactCount: 6,
    universeCount: 141,
    excluded: [],
  },
  notEvaluated: [],
  findings: [finding()],
  counts: { error: 1, warn: 0, note: 0 },
  thresholds: {
    maxErrors: 0,
    maxWarnings: 50,
    minScore: 0,
    severities: {},
    exclude: [],
    defaultBaseRef: 'origin/main',
  },
  overrides: [],
  suppressions: { used: 0, stale: [] },
  baseline: { applied: 0, stale: 0 },
  ...overrides,
})

const render = (input: Report, maxFindings = 25): string =>
  renderHuman(input, { maxFindings }).join('\n')

describe('renderHuman', () => {
  it('prints the verdict first and last, because CI logs are read from both ends', () => {
    const lines = renderHuman(report(), { maxFindings: 25 })
    expect(lines[0]).toContain('prompt-lint (diff vs origin/main)')
    expect(lines[lines.length - 1]).toBe('✖ thresholds breached — see above')
  })

  it('prints the passing verdict when nothing breached', () => {
    const lines = renderHuman(
      report({ verdict: 'pass', findings: [], counts: { error: 0, warn: 0, note: 0 } }),
      { maxFindings: 25 },
    )
    expect(lines[lines.length - 1]).toBe('✔ within thresholds')
  })

  it('prints counts against their thresholds', () => {
    expect(render(report())).toContain('errors:   1  (max 0)')
    expect(render(report())).toContain('warnings: 0  (max 50)')
  })

  it('prints every finding with its location, message and a → fix (FR-007, SC-006)', () => {
    const output = render(report())
    expect(output).toContain('✖ refs/dangling-path')
    expect(output).toContain('natural-transitions.md:276')
    expect(output).toContain('→ Point at an existing reference')
  })

  it('caps the list and states the omitted count, never silently (FR-037)', () => {
    const findings = Array.from({ length: 30 }, (_, index) =>
      finding({ line: index + 1, path: `a${String(index)}.md` }),
    )
    const output = render(report({ findings }), 3)
    expect(output).toContain('…and 27 more (raise with --max-findings)')
  })

  it('says nothing about a cap when nothing was omitted', () => {
    expect(render(report())).not.toContain('more (raise with')
  })

  it('replaces the body with one explicit line for an empty scope (FR-040)', () => {
    // It must not be possible to confuse "nothing to check" with a clean pass over a
    // populated set.
    const output = render(
      report({
        verdict: 'pass',
        scope: { mode: 'all', artifactCount: 0, universeCount: 0, excluded: [] },
        findings: [],
        counts: { error: 0, warn: 0, note: 0 },
      }),
    )
    expect(output).toContain('no AI-authored artifacts in scope')
    expect(output).not.toContain('errors:')
    expect(output).toContain('✔ within thresholds')
  })

  it('names every override in effect, above the verdict (FR-034)', () => {
    // A passing CI log must never be able to conceal a relaxed threshold.
    const output = render(report({ overrides: [{ name: 'PROMPT_LINT_MAX_ERRORS', value: '5' }] }))
    expect(output).toContain('overrides in effect: PROMPT_LINT_MAX_ERRORS=5')
    expect(output).toContain('must not be used to pass CI')
  })

  /**
   * The test above proves the renderer prints what it was handed. It does not prove the
   * pipeline carries an override from the environment into the log — and that is the whole
   * of FR-034: a passing CI log must never be able to conceal a relaxed threshold, and the
   * threshold is relaxed by a variable, not by a parameter. So these go through
   * `buildConfig` from a stubbed environment and assert on what comes out the far end.
   */
  describe('the override header, from the environment rather than from a parameter (FR-034)', () => {
    const THRESHOLD_VARIABLES = [
      'PROMPT_LINT_MAX_ERRORS',
      'PROMPT_LINT_MAX_WARNINGS',
      'PROMPT_LINT_MIN_SCORE',
      'PROMPT_LINT_BASE_REF',
    ]

    /**
     * Empty reads as unset in `buildConfig`, so a variable already exported in the shell
     * running the suite cannot leak into the assertions below. `no-dynamic-delete` is on
     * and `process.env` is not the thing under test — the stub is.
     */
    const withNoOverrides = (): void => {
      for (const name of THRESHOLD_VARIABLES) vi.stubEnv(name, '')
    }

    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('names every PROMPT_LINT_* variable the environment set', () => {
      withNoOverrides()
      vi.stubEnv('PROMPT_LINT_MAX_ERRORS', '5')
      vi.stubEnv('PROMPT_LINT_MAX_WARNINGS', '999')
      vi.stubEnv('PROMPT_LINT_MIN_SCORE', '10')
      vi.stubEnv('PROMPT_LINT_BASE_REF', 'origin/staging')

      const { config, overrides } = buildConfig()
      const output = render(report({ overrides, thresholds: config }))

      expect(output).toContain('PROMPT_LINT_MAX_ERRORS=5')
      expect(output).toContain('PROMPT_LINT_MAX_WARNINGS=999')
      expect(output).toContain('PROMPT_LINT_MIN_SCORE=10')
      expect(output).toContain('PROMPT_LINT_BASE_REF=origin/staging')
      expect(output).toContain('must not be used to pass CI')
      // And the relaxed number itself is beside the count, so a reader who skims past the
      // header still sees `max 5` where the shipped default is `max 0`.
      expect(output).toContain('errors:   1  (max 5)')
    })

    it('prints the header above the verdict, because it changes what the verdict means', () => {
      withNoOverrides()
      vi.stubEnv('PROMPT_LINT_MAX_ERRORS', '5')
      const { config, overrides } = buildConfig()
      const lines = renderHuman(report({ overrides, thresholds: config }), { maxFindings: 25 })
      expect(lines[0]).toContain('⚠ overrides in effect: PROMPT_LINT_MAX_ERRORS=5')
    })

    it('prints no header at all when the environment sets none, so the header means something', () => {
      withNoOverrides()
      const { config, overrides } = buildConfig()
      expect(overrides).toEqual([])
      expect(render(report({ overrides, thresholds: config }))).not.toContain('overrides in effect')
    })
  })

  it('states what was not evaluated rather than staying silent about it', () => {
    const output = render(
      report({ notEvaluated: [{ rule: 'meta/required-field' as RuleId, reason: 'unreadable' }] }),
    )
    expect(output).toContain('not evaluated:')
    expect(output).toContain('meta/required-field — unreadable')
  })

  it('reports the suppression and baseline bookkeeping in the footer', () => {
    const output = render(
      report({ suppressions: { used: 3, stale: [] }, baseline: { applied: 10, stale: 1 } }),
    )
    expect(output).toContain('suppressions: 3 used, 0 stale     baseline: 10 applied, 1 stale')
  })

  it('counts stale suppressions from the entries themselves, not from a separate tally', () => {
    // A stale count kept apart from the findings it describes is a count that can drift
    // from them — and a baseline that never drains is the thing FR-010 exists to surface.
    const output = render(
      report({
        suppressions: { used: 1, stale: [finding({ rule: 'suppression/stale' as RuleId })] },
        baseline: { applied: 0, stale: 2 },
      }),
    )
    expect(output).toContain('suppressions: 1 used, 1 stale     baseline: 0 applied, 2 stale')
  })

  it('tags a bundle-scoped finding with its bundle and prints no line number', () => {
    const output = render(
      report({
        findings: [
          finding({
            rule: 'contextops/concentration' as RuleId,
            line: 0,
            bundle: 'skill:review',
            path: 'a.md',
          }),
        ],
      }),
    )
    expect(output).toContain('[bundle skill:review]')
    expect(output).toContain('    a.md\n')
  })

  it('marks a baselined finding as pre-existing', () => {
    expect(render(report({ findings: [finding({ baselined: true })] }))).toContain(
      '[baselined: pre-existing at adoption]',
    )
  })

  // These are the properties that rot silently, so they are asserted as negatives.
  describe('determinism (FR-039, SC-005)', () => {
    it('emits no absolute path', () => {
      expect(render(report())).not.toMatch(/(^|\s)\//m)
    })

    it('emits no timestamp, date or duration', () => {
      const output = render(report())
      expect(output).not.toMatch(/\d{4}-\d{2}-\d{2}/)
      expect(output).not.toMatch(/\b\d+(\.\d+)?m?s\b/)
    })

    it('renders identically twice', () => {
      expect(render(report())).toBe(render(report()))
    })
  })
})

describe('renderRuleList', () => {
  it('prints id, ships-as severity, source and statement for each rule', () => {
    const output = renderRuleList([
      {
        id: 'refs/dangling-path',
        defaultSeverity: 'error',
        statement: 'Refs resolve.',
        source: 'prompt-lint',
      },
    ]).join('\n')
    expect(output).toContain('prompt-lint: 1 rules')
    expect(output).toContain('refs/dangling-path  [error]  (prompt-lint)')
    expect(output).toContain('Refs resolve.')
  })
})

describe('renderRuleExplanation', () => {
  it('answers with what, why, and where it applies', () => {
    const output = renderRuleExplanation({
      id: 'refs/dangling-path',
      defaultSeverity: 'error',
      statement: 'Refs resolve.',
      rationale: 'The agent silently loses a step.',
      appliesTo: ['catalog-skill'],
      dimension: 'correctness',
      scope: 'artifact',
      source: 'prompt-lint',
    }).join('\n')
    expect(output).toContain('what   Refs resolve.')
    expect(output).toContain('why    The agent silently loses a step.')
    expect(output).toContain('applies to catalog-skill')
  })

  it('says a bookkeeping rule’s severity is not configurable', () => {
    const output = renderRuleExplanation({
      id: 'artifact/unreadable',
      defaultSeverity: 'error',
      statement: 's',
      rationale: 'r',
      appliesTo: [],
      dimension: 'correctness',
      scope: 'artifact',
      source: 'prompt-lint',
      bookkeeping: true,
    }).join('\n')
    expect(output).toContain('not configurable')
  })
})
