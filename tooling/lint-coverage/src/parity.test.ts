import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { extractRules } from './extract'
import { ALL_FIXTURES, EXCUSED_RULES } from './fixtures'
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

  it('gives every excused rule a reason and a place it is covered instead', () => {
    for (const entry of EXCUSED_RULES) {
      expect(entry.reason.length).toBeGreaterThan(0)
      expect(entry.coveredBy.length).toBeGreaterThan(0)
    }
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
})
