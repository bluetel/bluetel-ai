import fs from 'node:fs'
import path from 'node:path'

import { bareRuleName } from './oxlint'

/**
 * Which layer enforces which rule, after the migration.
 *
 * The oxlint side is read from the committed `.oxlintrc.json` rather than restated here, so
 * the inventory cannot drift from the config it describes. The ESLint side is short enough
 * to list, and listing the exceptions rather than the majority means a rule can only stay
 * behind deliberately, with its reason recorded next to it.
 */

/** Rules that stay with ESLint after the migration, and why. */
export const ESLINT_WORKSPACE_RULES: Readonly<Partial<Record<string, string>>> = {
  '@nx/enforce-module-boundaries':
    'Needs the Nx project graph, which only exists inside an Nx invocation. It was silently skipped on the pre-migration staged path for exactly that reason — research.md §1.',
  '@cspell/spellchecker':
    'No oxlint equivalent. ~1555 ms per invocation, none of it scaling with file count, so it belongs to a cached per-project target.',
  'no-octal':
    'The one core ESLint rule in this workspace’s set that oxlint does not implement. Established by probing every rule name, not assumed.',
  'no-dupe-args':
    'Not implemented by oxlint. Only ever applied to .js/.mjs/.cjs files, since typescript-eslint switches it off for TypeScript.',
}

/**
 * Rules with no native oxlint implementation, which run through oxlint's
 * ESLint-v9-compatible JS plugin API instead, and the alias each is registered under.
 *
 * `import-x` and `unused-imports` collide with oxlint's built-in plugin namespaces, so those
 * two are aliased. oxlint refuses to load a JS plugin whose name collides with a built-in
 * one, which is a good deal better than silently shadowing it.
 */
export const OXLINT_JS_PLUGIN_RULES: Readonly<Partial<Record<string, string>>> = {
  'import-x/order': 'import-x-js/order',
  'check-file/filename-naming-convention': 'check-file/filename-naming-convention',
  'check-file/folder-naming-convention': 'check-file/folder-naming-convention',
  'prefer-arrow-functions/prefer-arrow-functions': 'prefer-arrow-functions/prefer-arrow-functions',
  'unused-imports/no-unused-imports': 'unused-imports-js/no-unused-imports',
  '@bluetel-ai/enforce-safe-env': 'bluetel-ai/enforce-safe-env',
}

export interface OxlintConfig {
  rules: Record<string, unknown>
  overrides?: { files: string[]; rules: Record<string, unknown> }[]
}

/** Read the committed oxlint config. */
export const readOxlintConfig = (repoRoot: string): OxlintConfig => {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(repoRoot, '.oxlintrc.json'), 'utf8'))
  return parsed as OxlintConfig
}

const isEnabledEntry = (entry: unknown): boolean => {
  const severity: unknown = Array.isArray(entry) ? (entry as unknown[])[0] : entry
  return severity !== 'off' && severity !== 0
}

/**
 * Every rule the oxlint layer enforces, by bare name.
 *
 * Bare names, because the two layers namespace the same rule differently and an inventory
 * that treated `@typescript-eslint/no-floating-promises` and
 * `typescript(no-floating-promises)` as different rules would report a complete migration as
 * a total loss of coverage.
 */
export const oxlintEnforcedRules = (config: OxlintConfig): Set<string> => {
  const enforced = new Set<string>()
  const collect = (rules: Record<string, unknown>) => {
    for (const [name, entry] of Object.entries(rules)) {
      if (isEnabledEntry(entry)) enforced.add(bareRuleName(name))
    }
  }
  collect(config.rules)
  for (const override of config.overrides ?? []) collect(override.rules)
  return enforced
}

/** Whether the oxlint layer owns a rule, given its ESLint rule ID. */
export const isOxlintOwned = (ruleId: string, enforced: ReadonlySet<string>): boolean =>
  ESLINT_WORKSPACE_RULES[ruleId] === undefined && enforced.has(bareRuleName(ruleId))
