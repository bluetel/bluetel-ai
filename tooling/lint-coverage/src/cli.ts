import fs from 'node:fs'
import path from 'node:path'

import { isEnabled, pluginOf, severityOf, optionsOf, type RuleEntry } from './classify'
import { extractRules, summarise, type ExtractedRule } from './extract'
import { renderInventory, type RuleAssignment } from './inventory'
import { ESLINT_WORKSPACE_RULES, readOxlintConfig } from './owners'

/**
 * Regenerate `specs/005-oxlint-lint-performance/rule-inventory.md`.
 *
 * Both layers are enumerated from what they actually run, not from a list kept alongside
 * them: the ESLint side by asking ESLint to resolve its config, the oxlint side by reading
 * the committed `.oxlintrc.json`. An inventory assembled by hand would agree with itself
 * forever and with the linters never.
 *
 * Run with `pnpm lint-inventory` from the repo root.
 */

/** One probe per file type the ESLint config discriminates on. */
const ESLINT_PROBES = [
  'packages/env-validation-errors/src/index.ts',
  'packages/env-validation-errors/src/probe.tsx',
  'eslint.config.mjs',
  'probe.cjs',
] as const

/**
 * The rule total after the migration, asserted rather than assumed.
 *
 * 147 rules were enforced before it — 129 for a TypeScript file plus the 18 core rules
 * typescript-eslint switches off for TypeScript but leaves on for `.js`/`.mjs`/`.cjs`.
 * One fewer survives, and the missing one is not a loss: ESLint had both
 * `unused-imports/no-unused-vars` (with this workspace's `^_` ignore patterns) and
 * `@typescript-eslint/no-unused-vars` (bare, `.mjs` only), and oxlint canonicalises both to
 * the single core `no-unused-vars`. The entry that survives is the one carrying the options,
 * so the rule is enforced everywhere it was, under one name instead of two.
 */
const EXPECTED_TOTAL = 146

/**
 * Turn one `.oxlintrc.json` entry into an inventory row.
 *
 * The severity is reported as written. An earlier version coerced `off` to `error` — which
 * made the inventory structurally incapable of showing a switched-off rule, in the file whose
 * whole job is to account for every enforced rule. `oxlintRows` drops disabled entries
 * instead, so turning a rule off changes the total, breaks `EXPECTED_TOTAL`, and shows up as
 * drift in the committed file rather than as a row that still claims `error`.
 */
const oxlintRow = (
  name: string,
  entry: RuleEntry,
  scope: 'base' | 'type-aware' | 'module-only',
): ExtractedRule => ({
  name,
  plugin: pluginOf(name),
  severity: severityOf(entry),
  options: optionsOf(entry),
  requiresTypeChecking: scope === 'type-aware',
  // oxlint does not expose per-rule fixability from the config, and guessing would put a
  // number in the table that nobody had checked.
  fixable: false,
  enabledFor: scope === 'module-only' ? ['*.mjs'] : ['*.ts'],
})

const main = async (): Promise<void> => {
  const repoRoot = process.cwd()

  const eslintRules = await extractRules({
    cwd: repoRoot,
    files: ESLINT_PROBES.map((file) => path.join(repoRoot, file)),
  })

  const oxlintConfig = readOxlintConfig(repoRoot)
  const typeAwareOverride = (oxlintConfig.overrides ?? []).find(
    (override) => override.files.includes('**/*.ts') && override.files.includes('**/*.tsx'),
  )
  const moduleOverride = (oxlintConfig.overrides ?? []).find((override) =>
    override.files.includes('**/*.mjs'),
  )

  const oxlintRows = (
    rules: Record<string, unknown>,
    scope: 'base' | 'type-aware' | 'module-only',
  ): ExtractedRule[] =>
    Object.entries(rules)
      .filter(([, entry]) => isEnabled(entry as RuleEntry))
      .map(([name, entry]) => oxlintRow(name, entry as RuleEntry, scope))

  const oxlintRules: ExtractedRule[] = [
    ...oxlintRows(oxlintConfig.rules, 'base'),
    ...oxlintRows(typeAwareOverride?.rules ?? {}, 'type-aware'),
    ...oxlintRows(moduleOverride?.rules ?? {}, 'module-only'),
  ]

  const all = [...eslintRules, ...oxlintRules].sort((a, b) => a.name.localeCompare(b.name))

  const assign = (rule: ExtractedRule): RuleAssignment => {
    const eslintReason = ESLINT_WORKSPACE_RULES[rule.name]
    if (eslintReason !== undefined) {
      return { owner: 'eslint-workspace', status: 'covered', notes: eslintReason }
    }
    if (rule.requiresTypeChecking) {
      return {
        owner: 'oxlint-type-aware',
        status: 'relocated',
        notes: 'Runs under oxlint-tsgolint, which embeds its own typechecker.',
      }
    }
    if (
      rule.name.includes('-js/') ||
      rule.name.startsWith('bluetel-ai/') ||
      rule.name.startsWith('check-file/') ||
      rule.name.startsWith('prefer-arrow-functions/')
    ) {
      return {
        owner: 'oxlint-js-plugin',
        status: 'relocated',
        notes: 'No native oxlint implementation; runs through the ESLint-compatible JS plugin API.',
      }
    }
    return { owner: 'oxlint-native', status: 'relocated' }
  }

  const markdown = renderInventory(all, assign, {
    generatedBy: 'pnpm lint-inventory',
    expectation: {
      label: 'Rules enforced across both layers',
      count: all.length,
      expected: EXPECTED_TOTAL,
      source:
        '`research.md` §2 plus the 18 core rules typescript-eslint switches off for TypeScript',
    },
  })

  const output = path.join(repoRoot, 'specs/005-oxlint-lint-performance/rule-inventory.md')
  fs.writeFileSync(output, markdown, 'utf8')

  const totals = summarise(all)
  process.stdout.write(
    `Wrote ${String(totals.total)} rules (${String(totals.typeAware)} type-aware, ${String(eslintRules.length)} still on ESLint) to ${path.relative(repoRoot, output)}\n`,
  )

  if (totals.total !== EXPECTED_TOTAL) {
    process.stdout.write(
      `Total is ${String(totals.total)}, not the ${String(EXPECTED_TOTAL)} expected after the migration. Reconcile before relying on the inventory.\n`,
    )
    process.exitCode = 1
  }
}

await main()
