import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildConfig, effectiveSeverity, validateConfig, type Config } from './config'

const KNOWN = ['refs/dangling-path', 'skill/use-when-trigger']

const baseConfig = (overrides: Partial<Config> = {}): Config => ({
  maxErrors: 0,
  maxWarnings: 50,
  minScore: 0,
  severities: {},
  exclude: [],
  defaultBaseRef: 'origin/main',
  ...overrides,
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('buildConfig', () => {
  it('ships the documented defaults, with minScore inert', () => {
    const { config, overrides } = buildConfig()
    expect(config).toMatchObject({
      maxErrors: 0,
      maxWarnings: 50,
      minScore: 0,
      defaultBaseRef: 'origin/main',
    })
    expect(overrides).toEqual([])
  })

  it('applies each PROMPT_LINT_* override and records it', () => {
    // FR-034: an override in effect is named in the report header, so a passing CI log
    // cannot conceal a relaxed threshold. Recording it here is what makes that possible.
    vi.stubEnv('PROMPT_LINT_MAX_ERRORS', '5')
    vi.stubEnv('PROMPT_LINT_BASE_REF', 'origin/staging')

    const { config, overrides } = buildConfig()
    expect(config.maxErrors).toBe(5)
    expect(config.defaultBaseRef).toBe('origin/staging')
    expect(overrides).toEqual([
      { name: 'PROMPT_LINT_MAX_ERRORS', value: '5' },
      { name: 'PROMPT_LINT_BASE_REF', value: 'origin/staging' },
    ])
  })

  it('ignores an unparsable numeric override rather than reading it as 0', () => {
    // Silently becoming `maxErrors: 0` would be safe; silently becoming NaN would make
    // every comparison false and the gate never fail.
    vi.stubEnv('PROMPT_LINT_MAX_ERRORS', 'lots')
    const { config, overrides } = buildConfig()
    expect(config.maxErrors).toBe(0)
    expect(overrides).toEqual([])
  })

  it('ignores an empty override', () => {
    vi.stubEnv('PROMPT_LINT_BASE_REF', '')
    expect(buildConfig().config.defaultBaseRef).toBe('origin/main')
  })

  it('offers no environment override for severities or exclusions (FR-034, SC-009)', () => {
    // Those change *what* is checked rather than how strictly, so they must appear in a
    // diff. Asserted by absence: no code path reads an env var into either field.
    vi.stubEnv('PROMPT_LINT_SEVERITIES', 'refs/dangling-path=note')
    vi.stubEnv('PROMPT_LINT_EXCLUDE', '**/*.md')
    const { config, overrides } = buildConfig()
    expect(config.severities).toEqual({})
    expect(config.exclude).toEqual([])
    expect(overrides).toEqual([])
  })

  it('returns a fresh exclude array each time, so one run cannot mutate the next', () => {
    const first = buildConfig().config
    first.exclude.push({ glob: 'x', reason: 'y' })
    expect(buildConfig().config.exclude).toEqual([])
  })
})

describe('validateConfig', () => {
  it('accepts the shipped defaults', () => {
    expect(validateConfig(buildConfig().config, { knownRuleIds: KNOWN })).toEqual([])
  })

  it.each([
    ['minScore below 0', { minScore: -1 }],
    ['minScore above 100', { minScore: 101 }],
  ])('rejects %s as a gate that can never pass or never fail', (_label, overrides) => {
    const errors = validateConfig(baseConfig(overrides), { knownRuleIds: KNOWN })
    expect(errors).toHaveLength(1)
    expect(errors[0].setting).toBe('minScore')
  })

  it('accepts the boundaries', () => {
    for (const minScore of [0, 100]) {
      expect(validateConfig(baseConfig({ minScore }), { knownRuleIds: KNOWN })).toEqual([])
    }
  })

  it('rejects a negative or fractional threshold', () => {
    expect(validateConfig(baseConfig({ maxErrors: -1 }), { knownRuleIds: KNOWN })).toHaveLength(1)
    expect(validateConfig(baseConfig({ maxWarnings: 1.5 }), { knownRuleIds: KNOWN })).toHaveLength(
      1,
    )
  })

  it('rejects a severities key naming no registered rule — this is what catches a rename', () => {
    const errors = validateConfig(baseConfig({ severities: { 'refs/renamed-away': 'warn' } }), {
      knownRuleIds: KNOWN,
    })
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('refs/renamed-away')
    expect(errors[0].message).toContain('rename')
  })

  it('accepts a severities key that does name a registered rule', () => {
    expect(
      validateConfig(baseConfig({ severities: { 'skill/use-when-trigger': 'warn' } }), {
        knownRuleIds: KNOWN,
      }),
    ).toEqual([])
  })

  it('rejects an exclusion with no reason (FR-005)', () => {
    const errors = validateConfig(baseConfig({ exclude: [{ glob: 'a/**', reason: '  ' }] }), {
      knownRuleIds: KNOWN,
    })
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('a/**')
  })

  it('rejects an exclusion with no glob', () => {
    expect(
      validateConfig(baseConfig({ exclude: [{ glob: '', reason: 'because' }] }), {
        knownRuleIds: KNOWN,
      }),
    ).toHaveLength(1)
  })

  it('rejects an empty defaultBaseRef', () => {
    expect(
      validateConfig(baseConfig({ defaultBaseRef: '' }), { knownRuleIds: KNOWN }),
    ).toHaveLength(1)
  })

  it('reports every problem at once rather than the first', () => {
    const errors = validateConfig(
      baseConfig({ minScore: 200, maxErrors: -1, severities: { 'a/b': 'note' } }),
      { knownRuleIds: KNOWN },
    )
    expect(errors.map((error) => error.setting).sort()).toEqual([
      'maxErrors',
      'minScore',
      "severities['a/b']",
    ])
  })
})

describe('effectiveSeverity', () => {
  it('prefers the config override, which is the staged-adoption lever', () => {
    const config = baseConfig({ severities: { 'skill/use-when-trigger': 'warn' } })
    expect(effectiveSeverity(config, 'skill/use-when-trigger', 'error')).toBe('warn')
  })

  it('falls back to the rule’s own default', () => {
    expect(effectiveSeverity(baseConfig(), 'refs/dangling-path', 'error')).toBe('error')
  })
})
