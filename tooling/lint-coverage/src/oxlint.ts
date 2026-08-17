import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { MaterialisedFixture } from './parity'

/**
 * Running the oxlint layer over the same fixtures the ESLint layer is held to.
 *
 * The two layers report rule IDs in different shapes — ESLint says
 * `@typescript-eslint/no-floating-promises`, oxlint says
 * `typescript(no-floating-promises)` — so the comparison is on the rule's own name with the
 * namespace stripped from both sides. Comparing the raw strings would make every rule look
 * like it had stopped running.
 */

export interface OxlintDiagnostic {
  filename?: string
  code?: string
}

/** Strip the namespace from either layer's rule ID, leaving the rule's own name. */
export const bareRuleName = (ruleId: string): string => {
  const parenthesised = /\(([^)]+)\)\s*$/.exec(ruleId)
  const withoutNamespace = parenthesised === null ? ruleId : parenthesised[1]
  const lastSlash = withoutNamespace.lastIndexOf('/')
  return lastSlash === -1 ? withoutNamespace : withoutNamespace.slice(lastSlash + 1)
}

export interface OxlintRunOptions {
  /** Repo root — oxlint resolves `node_modules/.bin/oxlint` and the config from here. */
  cwd: string
  /** Paths to lint. */
  paths: readonly string[]
  /** Whether to enable the rules that need type information. */
  typeAware: boolean
  /** Config to lint with. Defaults to whatever oxlint discovers. */
  configPath?: string
}

/**
 * Write a copy of the workspace oxlint config with its `ignorePatterns` removed, so the
 * harness can lint the fixture tree the workspace config deliberately excludes.
 *
 * Derived from the real config rather than written by hand: a second hand-maintained rule
 * list would drift from the first, and a harness that checks a config nobody runs is worse
 * than no harness. Only the ignore list differs.
 *
 * `jsPlugins` specifiers are relative to the config file, so they are made absolute on the
 * way out — otherwise the copy would resolve them against wherever it happens to be written.
 */
export const writeUnignoredConfig = (repoRoot: string, target: string): string => {
  const source = path.join(repoRoot, '.oxlintrc.json')
  const config = JSON.parse(fs.readFileSync(source, 'utf8')) as {
    ignorePatterns?: unknown
    jsPlugins?: { name: string; specifier: string }[]
  }
  delete config.ignorePatterns
  config.jsPlugins = (config.jsPlugins ?? []).map((plugin) => ({
    name: plugin.name,
    specifier: path.resolve(repoRoot, plugin.specifier),
  }))
  fs.writeFileSync(target, JSON.stringify(config, null, 2), 'utf8')
  return target
}

/**
 * Run oxlint and return, per file, the set of rule names it reported.
 *
 * oxlint exits non-zero when it reports anything, so a non-zero exit is the expected case
 * here and only a missing binary or an unparsable config is a real failure.
 */
export const runOxlint = (options: OxlintRunOptions): Map<string, Set<string>> => {
  const args = [
    '--format',
    'json',
    ...(options.configPath === undefined ? [] : ['--config', options.configPath]),
    ...(options.typeAware ? ['--type-aware'] : []),
    ...options.paths,
  ]

  let stdout: string
  try {
    stdout = execFileSync(path.join(options.cwd, 'node_modules/.bin/oxlint'), args, {
      cwd: options.cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    const withOutput = error as { stdout?: string; stderr?: string }
    if (withOutput.stdout === undefined || withOutput.stdout.trim() === '') {
      throw new Error(`oxlint failed to run: ${withOutput.stderr ?? String(error)}`)
    }
    stdout = withOutput.stdout
  }

  const parsed = JSON.parse(stdout) as OxlintDiagnostic[] | { diagnostics?: OxlintDiagnostic[] }
  const diagnostics = Array.isArray(parsed) ? parsed : (parsed.diagnostics ?? [])

  const byFile = new Map<string, Set<string>>()
  for (const diagnostic of diagnostics) {
    const file = path.basename(diagnostic.filename ?? '')
    const existing = byFile.get(file) ?? new Set<string>()
    if (diagnostic.code !== undefined) existing.add(bareRuleName(diagnostic.code))
    byFile.set(file, existing)
  }
  return byFile
}

/** A fixture whose rule the oxlint layer did not report. */
export interface OxlintParityFailure {
  rule: string
  file: string
  reportedInstead: string[]
}

export const findSilentOxlintRules = (
  materialised: readonly MaterialisedFixture[],
  reported: Map<string, Set<string>>,
  ownedBy: (rule: string) => boolean,
): OxlintParityFailure[] =>
  materialised
    .filter(({ fixture }) => ownedBy(fixture.rule))
    .filter(
      ({ fixture }) =>
        !(reported.get(fixture.filename) ?? new Set<string>()).has(bareRuleName(fixture.rule)),
    )
    .map(({ fixture }) => ({
      rule: fixture.rule,
      file: fixture.filename,
      reportedInstead: [...(reported.get(fixture.filename) ?? [])],
    }))
