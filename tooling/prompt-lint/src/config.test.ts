import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildConfig, effectiveSeverity, validateConfig, type Config } from './config'

const KNOWN = ['refs/dangling-path', 'skill/use-when-trigger']

const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * Every shipped (non-test) source file. The FR-034/SC-009 assertions below scan these
 * rather than only `config.ts`, because an escape hatch added in `gate.ts` or a rule
 * module would otherwise sit outside the scan and the absence would stop being real.
 */
const implementationSources = (): { path: string; source: string }[] =>
  readdirSync(SOURCE_ROOT, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        entry.name !== 'test-helpers.ts',
    )
    .map((entry) => {
      const absolute = join(entry.parentPath, entry.name)
      return { path: relative(SOURCE_ROOT, absolute), source: readFileSync(absolute, 'utf8') }
    })

const sourceOf = (path: string): string => {
  const file = implementationSources().find((entry) => entry.path === path)
  if (file === undefined) throw new Error(`${path} is not in the source tree`)
  return file.source
}

/**
 * The `PROMPT_LINT_*` variables `contracts/cli.md` documents. Every one of them changes
 * *how strictly* the tree is judged, and every one is named in the report header.
 *
 * A future variable belongs on this list only if that is true of it too —
 * `PROMPT_LINT_CONTEXTOPS_BIN` (Phase 6) qualifies, because it changes *where* the
 * analyser is found and never which version counts. Adding a name here is a deliberate,
 * reviewable edit, and the behavioural test below then holds the new name to the same
 * rule as these four.
 */
const DOCUMENTED_OVERRIDES = [
  'PROMPT_LINT_BASE_REF',
  'PROMPT_LINT_MAX_ERRORS',
  'PROMPT_LINT_MAX_WARNINGS',
  'PROMPT_LINT_MIN_SCORE',
]

/**
 * Every environment variable name a source file reads, taken from the source rather than
 * guessed: the name literals handed to the `envNum`/`envStr` helpers, plus any direct
 * `process.env.NAME` access. Deriving the list is what lets the behavioural test cover a
 * hatch under a name this suite would never have thought to try.
 */
const environmentNamesIn = (source: string): string[] =>
  [
    ...new Set([
      ...[...source.matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)].map((match) => match[1]),
      ...[...source.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]),
    ]),
  ].sort()

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

  it('returns a fresh exclude array each time, so one run cannot mutate the next', () => {
    const first = buildConfig().config
    first.exclude.push({ glob: 'x', reason: 'y' })
    expect(buildConfig().config.exclude).toEqual([])
  })
})

/**
 * The severities map and the exclusion list change *what* is checked rather than *how
 * strictly*, so FR-034/SC-009 require a change to either to appear in a diff. That is a
 * requirement about something that must **not** exist, which no single stubbed variable
 * can establish — a test that sets `PROMPT_LINT_SEVERITIES` and sees nothing happen
 * passes for a name nobody would ever have chosen.
 *
 * So the absence is asserted three ways, each closing the hole the previous one leaves:
 * the name shape (no new `PROMPT_LINT_*` anywhere in the tree), the location (only
 * `config.ts` may read a named variable, which is what makes the derived list complete),
 * and the behaviour (no name `config.ts` actually reads can move either field, whatever
 * that name turns out to be).
 */
describe('no environment variable can change a per-rule severity or the exclusion list', () => {
  it('names the obvious hatches explicitly, so the requirement is legible here', () => {
    vi.stubEnv('PROMPT_LINT_SEVERITIES', 'refs/dangling-path=note')
    vi.stubEnv('PROMPT_LINT_SEVERITY_REFS_DANGLING_PATH', 'note')
    vi.stubEnv('PROMPT_LINT_EXCLUDE', '**/*.md')
    const { config, overrides } = buildConfig()
    expect(config.severities).toEqual({})
    expect(config.exclude).toEqual([])
    expect(overrides).toEqual([])
  })

  it('declares no PROMPT_LINT_* variable beyond the documented thresholds, anywhere in the tree', () => {
    // The strongest half: this fails for a hatch under *any* `PROMPT_LINT_*` name, and it
    // fails on the mention rather than on the behaviour, so a half-built one is caught too.
    const mentioned = new Set(
      implementationSources().flatMap((file) =>
        [...file.source.matchAll(/PROMPT_LINT_[A-Z0-9_]+/g)].map((match) => match[0]),
      ),
    )
    expect([...mentioned].sort()).toEqual(DOCUMENTED_OVERRIDES)
  })

  it('reads a named environment variable in config.ts and nowhere else', () => {
    // Which is what makes the derived list in the next test exhaustive. `scope/git.ts`
    // enumerates the whole environment to strip `GIT_*` before spawning git; it reads no
    // name of its own, so it is not an exception to this.
    const offenders = implementationSources()
      .filter((file) => file.path !== 'config.ts' && /process\.env(\[|\.)/.test(file.source))
      .map((file) => file.path)
    expect(offenders).toEqual([])
  })

  it('reads exactly the documented threshold variables and no others', () => {
    expect(environmentNamesIn(sourceOf('config.ts'))).toEqual(DOCUMENTED_OVERRIDES)
  })

  it('leaves severities and exclude invariant under every variable it does read', () => {
    // Derived from the source, so this holds a hatch to account under a name the suite was
    // never told about — including one that does not start with `PROMPT_LINT_`. Compared
    // against the build with nothing stubbed rather than against `{}`, so it keeps working
    // once a rule ships demoted in `SHIPPED_SEVERITIES`.
    const shipped = buildConfig().config
    const values = ['refs/dangling-path=note', 'note', '**/*.md', 'tooling/skills/**', '1']

    for (const name of environmentNamesIn(sourceOf('config.ts'))) {
      for (const value of values) {
        vi.stubEnv(name, value)
        const { config } = buildConfig()
        expect(config.severities, `${name}=${value} moved a per-rule severity`).toEqual(
          shipped.severities,
        )
        expect(config.exclude, `${name}=${value} moved the exclusion list`).toEqual(shipped.exclude)
        vi.unstubAllEnvs()
      }
    }
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
