import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { extractRules } from './extract'
import { ALL_FIXTURES, EXCUSED_RULES, SYNTACTIC_FIXTURES, TYPE_AWARE_FIXTURES } from './fixtures'
import {
  ESLINT_WORKSPACE_RULES,
  isOxlintOwned,
  oxlintEnforcedRules,
  readOxlintConfig,
} from './owners'
import { bareRuleName, findSilentOxlintRules, runOxlint, writeUnignoredConfig } from './oxlint'
import {
  cleanFixtures,
  createFixtureDir,
  lintFixtures,
  materialiseFixtures,
  type FixtureResult,
  type MaterialisedFixture,
} from './parity'

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repoRoot = path.dirname(path.dirname(packageRoot))
const workspaceConfig = path.join(repoRoot, 'eslint.config.mjs')

/**
 * The fixtures live inside the repository, not in a temp directory, because both linters
 * scope their `files` patterns to the tree they are run from — a fixture in `/tmp` matches
 * none of them and every rule looks silent. They are excluded from `pnpm lint` by
 * `ignorePatterns`, which is exactly what the harness's derived config removes.
 */
const fixturesRoot = path.join(packageRoot, 'fixtures', 'generated')

const oxlintEnforced = oxlintEnforcedRules(readOxlintConfig(repoRoot))
const ownedByOxlint = (rule: string) => isOxlintOwned(rule, oxlintEnforced)

let materialised: MaterialisedFixture[]
let eslintResults: FixtureResult[]
let oxlintReported: Map<string, Set<string>>

beforeAll(async () => {
  materialised = materialiseFixtures({ fixturesRoot, fixtures: ALL_FIXTURES })
  eslintResults = await lintFixtures(materialised, {
    cwd: repoRoot,
    overrideConfigFile: workspaceConfig,
  })
  oxlintReported = runOxlint({
    cwd: repoRoot,
    paths: [fixturesRoot],
    typeAware: true,
    configPath: writeUnignoredConfig(repoRoot, path.join(createFixtureDir(), 'oxlintrc.json')),
  })
}, 300_000)

// The fixtures stay on disk: they are committed, and `materialiseFixtures` rewriting them
// from `fixtures.ts` on every run is what keeps the two from drifting apart.
afterAll(() => {
  cleanFixtures(path.join(fixturesRoot, 'tsconfig.json'))
})

describe('the oxlint layer still enforces every rule it took over', () => {
  it('reports no silent rules', () => {
    expect(findSilentOxlintRules(materialised, oxlintReported, ownedByOxlint)).toEqual([])
  })

  // A case per rule as well as the aggregate: the aggregate says the suite failed, these say
  // which rule stopped running, which is what anyone reading a red run actually needs.
  for (const fixture of ALL_FIXTURES.filter((f) => ownedByOxlint(f.rule))) {
    it(`${fixture.rule} still fires`, () => {
      expect([...(oxlintReported.get(fixture.filename) ?? [])]).toContain(
        bareRuleName(fixture.rule),
      )
    })
  }
})

describe('the ESLint layer still enforces the rules that stayed with it', () => {
  for (const fixture of ALL_FIXTURES.filter((f) => !ownedByOxlint(f.rule))) {
    it(`${fixture.rule} still fires`, () => {
      const result = eslintResults.find((candidate) => candidate.fixture.rule === fixture.rule)
      expect(result?.reportedRules).toContain(fixture.rule)
    })
  }
})

describe('the two layers do not overlap (SC-008)', () => {
  it('no rule is enforced by both', async () => {
    const eslintRules = await extractRules({
      cwd: repoRoot,
      files: [
        path.join(repoRoot, 'packages/env-validation-errors/src/index.ts'),
        path.join(repoRoot, 'eslint.config.mjs'),
      ],
      overrideConfigFile: workspaceConfig,
    })

    const overlapping = eslintRules
      .map((rule) => rule.name)
      .filter((name) => oxlintEnforced.has(bareRuleName(name)))

    expect(overlapping).toEqual([])
  }, 120_000)

  it('the ESLint layer is exactly the rules that could not move', async () => {
    const eslintRules = await extractRules({
      cwd: repoRoot,
      files: [
        path.join(repoRoot, 'packages/env-validation-errors/src/index.ts'),
        path.join(repoRoot, 'eslint.config.mjs'),
      ],
      overrideConfigFile: workspaceConfig,
    })

    expect(eslintRules.map((rule) => rule.name).sort((a, b) => a.localeCompare(b))).toEqual(
      Object.keys(ESLINT_WORKSPACE_RULES).sort((a, b) => a.localeCompare(b)),
    )
  }, 120_000)
})

describe('rule accounting (SC-005)', () => {
  it('every previously-enforced rule has an owner, and none was dropped', () => {
    const unowned = ALL_FIXTURES.map((fixture) => fixture.rule).filter(
      (rule) => !ownedByOxlint(rule) && ESLINT_WORKSPACE_RULES[rule] === undefined,
    )
    expect(unowned).toEqual([])
  })

  /**
   * The harness's own contract, asserted rather than trusted.
   *
   * `fixtures.ts` claims one planted violation per rule that stayed with ESLint, or an
   * `EXCUSED_RULES` entry saying why not. Nothing enforced that claim, and two rules
   * (`no-octal`, `no-dupe-args`) had drifted out of both lists — leaving exactly the blind
   * spot this package exists to remove, in the one layer where it is least visible: a rule
   * that silently stops firing on the ESLint side cannot be caught by diffing the oxlint
   * config either.
   */
  it('gives every rule left on ESLint a fixture or a recorded excuse', () => {
    const planted = new Set(ALL_FIXTURES.map((fixture) => fixture.rule))
    const excused = new Set(EXCUSED_RULES.map((entry) => entry.rule))

    const unchecked = Object.keys(ESLINT_WORKSPACE_RULES).filter(
      (rule) => !planted.has(rule) && !excused.has(rule),
    )

    expect(unchecked).toEqual([])
  })

  it('gives every excused rule a reason and a place it is covered instead', () => {
    for (const entry of EXCUSED_RULES) {
      expect(entry.reason.length).toBeGreaterThan(0)
      expect(entry.coveredBy.length).toBeGreaterThan(0)
    }
  })

  /**
   * The "preset assertion" two `EXCUSED_RULES` entries cite — which did not exist until
   * re-review went looking for it. Asserting only that the prose is non-empty made the excuse
   * mechanism look enforced while checking nothing, so a rule could be excused *to* a test that
   * was never written. These two cannot be planted as a standalone file (one keys off a folder
   * layout, the other needs a React component), so config presence with the right options is
   * the strongest available check — and it is at least a check.
   */
  it('keeps the excused-to-config rules enabled with their options', () => {
    const config = readOxlintConfig(repoRoot)

    expect(config.rules['check-file/folder-naming-convention']).toEqual([
      'error',
      { 'src/components/**/': 'KEBAB_CASE', 'src/lib/**/': 'KEBAB_CASE' },
    ])
    expect(config.rules['react/react-compiler']).toBe('error')
  })
})

/**
 * The committed inventory, checked against the configs it claims to describe.
 *
 * `pnpm lint-inventory` reproducing the committed file byte-for-byte is the drift gate for the
 * ~89 enforced rules that have no fixture — but a gate is only as good as what it can
 * represent. Two defects found by re-review, both fixed and both pinned here: the generator
 * used to rewrite a `severity: off` rule as `error`, so a rule could be switched off with the
 * inventory unchanged and every test green; and nothing tied the fixture corpus to the config,
 * so deleting a fixture deleted its own test case.
 */
describe('the committed inventory matches the configs (SC-005)', () => {
  const inventory = fs.readFileSync(
    path.join(repoRoot, 'specs/005-oxlint-lint-performance/rule-inventory.md'),
    'utf8',
  )

  /** Rule names from the `## Rules` table: the first cell of each row, inside backticks. */
  const inventoryRules = [...inventory.matchAll(/^ \| `([^`]+)` \| `/gm)].map((match) => match[1])

  const oxlintConfig = readOxlintConfig(repoRoot)
  const enabledOxlintKeys = new Set(
    [oxlintConfig.rules, ...(oxlintConfig.overrides ?? []).map((override) => override.rules)]
      .flatMap((rules) => Object.entries(rules))
      .filter(([, entry]) => {
        const severity = Array.isArray(entry) ? (entry as unknown[])[0] : entry
        return severity !== 'off' && severity !== 0
      })
      .map(([name]) => name),
  )

  it('lists no rule that either layer has since switched off', () => {
    const stale = inventoryRules.filter(
      (rule) => !enabledOxlintKeys.has(rule) && ESLINT_WORKSPACE_RULES[rule] === undefined,
    )
    expect(stale).toEqual([])
  })

  it('lists every rule the oxlint config enables', () => {
    const missing = [...enabledOxlintKeys].filter((rule) => !inventoryRules.includes(rule))
    expect(missing).toEqual([])
  })

  it('records no rule as enforced at severity off', () => {
    const offRows = [...inventory.matchAll(/^ \| `([^`]+)` \| `[^`]+` \| (\S+) \|/gm)]
      .filter((match) => match[2] === 'off')
      .map((match) => match[1])
    expect(offRows).toEqual([])
  })

  /**
   * Every type-aware rule needs a fixture, derived from the config rather than from the
   * fixture list — the 41 rules that changed typechecker are the migration's real regression
   * risk, and a corpus that only checks itself cannot notice one of them going missing.
   */
  it('has a fixture for every type-aware rule oxlint runs', () => {
    const typeAware = Object.keys(
      (oxlintConfig.overrides ?? []).find(
        (override) => override.files.includes('**/*.ts') && override.files.includes('**/*.tsx'),
      )?.rules ?? {},
    )
    const planted = new Set(ALL_FIXTURES.map((fixture) => bareRuleName(fixture.rule)))

    expect(typeAware.filter((rule) => !planted.has(bareRuleName(rule)))).toEqual([])
    expect(typeAware).toHaveLength(41)
  })
})

describe('fixture corpus', () => {
  it('has a unique file name per fixture', () => {
    const names = ALL_FIXTURES.map((fixture) => fixture.filename)
    expect(new Set(names).size).toBe(names.length)
  })

  it('has a unique rule per fixture', () => {
    const rules = ALL_FIXTURES.map((fixture) => fixture.rule)
    expect(new Set(rules).size).toBe(rules.length)
  })

  /**
   * The size is written down on purpose.
   *
   * Every parity case is generated from `ALL_FIXTURES`, so deleting a fixture deletes its own
   * test and the suite stays green with fewer rules checked — the same shape of invisible loss
   * the harness exists to catch, one level up. The type-aware 41 are pinned against the config
   * above; this pins the 16 the workspace configures by hand, which no config can derive.
   */
  it('is the size it is meant to be', () => {
    expect(ALL_FIXTURES).toHaveLength(57)
    expect(SYNTACTIC_FIXTURES).toHaveLength(16)
    expect(TYPE_AWARE_FIXTURES).toHaveLength(41)
  })
})
