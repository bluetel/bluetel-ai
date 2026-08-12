import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ESLint } from 'eslint'

import type { RuleFixture } from './fixtures'

/**
 * A fresh scratch directory outside the repository, for the derived oxlint config the harness
 * writes per run.
 *
 * The fixtures themselves are **not** here, though an earlier version of this harness put them
 * here and this docstring used to argue for it. Both linters scope their `files` patterns to the
 * tree they are run from, so a fixture in `os.tmpdir()` matches none of them and every rule
 * reports silent — the exact false negative the harness exists to detect. They live in
 * `fixtures/generated/` instead, excluded from the repo's gates by config rather than by
 * location (`parity.test.ts:29-34`).
 *
 * Kept for the scratch config, and the naming constraint is kept with it: no leading dot.
 * `check-file`'s patterns go through micromatch with the default `dot: false`, so a `**` glob
 * never descends into a dot-directory and `check-file/filename-naming-convention` reported
 * nothing at all — a rule looking exactly as silent as one that had stopped working.
 */
export const createFixtureDir = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'lint-coverage-'))

const FIXTURE_TSCONFIG = {
  compilerOptions: {
    target: 'ES2020',
    module: 'ESNext',
    moduleResolution: 'bundler',
    strict: true,
    skipLibCheck: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    isolatedModules: true,
    lib: ['ES2022', 'DOM'],
    types: ['node'],
    noEmit: true,
  },
  include: ['*.ts', '*.tsx'],
  exclude: [],
}

export interface MaterialiseOptions {
  /** An empty directory to write into, from `createFixtureDir()`. */
  fixturesRoot: string
  fixtures: readonly RuleFixture[]
}

export interface MaterialisedFixture {
  fixture: RuleFixture
  /** Absolute path of the written file. */
  file: string
}

/**
 * Write the fixtures to disk, along with the `tsconfig.json` that puts them in a program.
 *
 * They have to exist as real files: type-aware rules need the file to be part of a
 * TypeScript program, which means a path a `tsconfig.json` can `include`.
 */
export const materialiseFixtures = ({
  fixturesRoot,
  fixtures,
}: MaterialiseOptions): MaterialisedFixture[] => {
  fs.mkdirSync(fixturesRoot, { recursive: true })
  fs.writeFileSync(
    path.join(fixturesRoot, 'tsconfig.json'),
    `${JSON.stringify(FIXTURE_TSCONFIG, null, 2)}\n`,
    'utf8',
  )

  return fixtures.map((fixture) => {
    const file = path.join(fixturesRoot, fixture.filename)
    fs.writeFileSync(file, fixture.code, 'utf8')
    return { fixture, file }
  })
}

/** Remove a path the harness created. */
export const cleanFixtures = (target: string): void => {
  fs.rmSync(target, { recursive: true, force: true })
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
    // The workspace config excludes the fixture tree, for the same reason the oxlint config
    // does: it is full of deliberate violations. The harness has to look past that, or every
    // rule it is meant to be checking reports nothing and the suite reads as a total loss of
    // coverage rather than as a misconfigured harness.
    ignore: false,
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
