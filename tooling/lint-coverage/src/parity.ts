import fs from 'node:fs'
import path from 'node:path'

import { ESLint } from 'eslint'

import type { RuleFixture } from './fixtures'

/**
 * Where fixtures are written before being linted. Gitignored; recreated on every run.
 *
 * Deliberately not a dot-directory. `check-file`'s patterns go through micromatch with the
 * default `dot: false`, so a `**` glob does not descend into `.generated` and
 * `check-file/filename-naming-convention` reported nothing at all — a rule looking exactly
 * as silent as one that had stopped working.
 */
export const GENERATED_DIR = 'generated'

export interface MaterialiseOptions {
  /** The `fixtures/` directory. Must already contain the `tsconfig.json` the fixtures compile under. */
  fixturesRoot: string
  fixtures: readonly RuleFixture[]
}

export interface MaterialisedFixture {
  fixture: RuleFixture
  /** Absolute path of the written file. */
  file: string
}

/**
 * Write the fixtures to disk under `<fixturesRoot>/generated`, replacing whatever was
 * there before.
 *
 * They have to exist as real files: type-aware rules need the file to be part of a
 * TypeScript program, which means a path a `tsconfig.json` can `include`.
 */
export const materialiseFixtures = ({
  fixturesRoot,
  fixtures,
}: MaterialiseOptions): MaterialisedFixture[] => {
  const target = path.join(fixturesRoot, GENERATED_DIR)
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })

  return fixtures.map((fixture) => {
    const file = path.join(target, fixture.filename)
    fs.writeFileSync(file, fixture.code, 'utf8')
    return { fixture, file }
  })
}

/** Remove the generated fixture tree. */
export const cleanFixtures = (fixturesRoot: string): void => {
  fs.rmSync(path.join(fixturesRoot, GENERATED_DIR), { recursive: true, force: true })
}

export interface LintLayerOptions {
  /** Directory the config is resolved from — the repo root for the workspace config. */
  cwd: string
  /** Lint with this config file instead of the one ESLint would look up. */
  overrideConfigFile?: string
}

/** The rule IDs a layer reported for one file. */
export interface FixtureResult {
  fixture: RuleFixture
  file: string
  reportedRules: string[]
}

/**
 * Run the ESLint layer over the materialised fixtures and collect the rule IDs it reported.
 *
 * Reported rule IDs are what gets asserted on, never the exit code. A non-zero exit only
 * says *something* objected; it does not say the rule under test is still running. A fixture
 * that trips a different rule while the one it was written for has gone silent would pass an
 * exit-code check and is precisely the regression this harness exists to catch.
 */
export const lintFixtures = async (
  materialised: readonly MaterialisedFixture[],
  options: LintLayerOptions,
): Promise<FixtureResult[]> => {
  const eslint = new ESLint({
    cwd: options.cwd,
    // Fixtures live outside any linted tree, so ESLint would otherwise warn about each one.
    warnIgnored: false,
    ...(options.overrideConfigFile === undefined
      ? {}
      : { overrideConfigFile: options.overrideConfigFile }),
  })

  const results: FixtureResult[] = []
  for (const { fixture, file } of materialised) {
    // `lintFiles` returns one result per linted file, or none at all if the file turned
    // out to be ignored — flattening covers both without pretending the empty case is
    // impossible.
    const lintResults = await eslint.lintFiles([file])
    const reportedRules = [
      ...new Set(
        lintResults
          .flatMap((lintResult) => lintResult.messages)
          .map((message) => message.ruleId)
          .filter((ruleId): ruleId is string => ruleId !== null),
      ),
    ].sort((a, b) => a.localeCompare(b))
    results.push({ fixture, file, reportedRules })
  }
  return results
}

/** A fixture whose rule did not fire — i.e. a rule that has stopped being enforced. */
export interface ParityFailure {
  rule: string
  file: string
  /** What did fire instead, which is usually the clue to why. */
  reportedInstead: string[]
}

/** Every fixture whose own rule did not appear in the diagnostics. */
export const findSilentRules = (results: readonly FixtureResult[]): ParityFailure[] =>
  results
    .filter((result) => !result.reportedRules.includes(result.fixture.rule))
    .map((result) => ({
      rule: result.fixture.rule,
      file: path.basename(result.file),
      reportedInstead: result.reportedRules,
    }))
