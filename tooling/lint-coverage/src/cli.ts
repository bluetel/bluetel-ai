import fs from 'node:fs'
import path from 'node:path'

import { extractRules, summarise } from './extract'
import { renderInventory } from './inventory'
import { preMigrationAssignment } from './owners'

/**
 * Regenerate `specs/005-oxlint-lint-performance/rule-inventory.md` from the resolved lint
 * config. Run with `pnpm lint-inventory` from the repo root.
 *
 * The probe files are one per file type the config discriminates on. A rule scoped to
 * `**\/*.{ts,tsx}` would be missing from the inventory if only a `.mjs` file were probed —
 * an omission that would look exactly like a rule that is not enabled.
 */
const TYPESCRIPT_PROBE = 'packages/env-validation-errors/src/index.ts'

const PROBE_FILES = [
  TYPESCRIPT_PROBE,
  'packages/env-validation-errors/src/probe.tsx',
  'eslint.config.mjs',
  'probe.cjs',
] as const

/**
 * The rule count `research.md` §2 recorded, asserted rather than assumed.
 *
 * It is the count for a **TypeScript** file specifically. The inventory's own total is
 * larger, because `typescript-eslint`'s `eslint-recommended` turns off the core rules the
 * compiler already covers — but only for TypeScript files, so a `.mjs` file has those back.
 */
const EXPECTED_TYPESCRIPT_TOTAL = 129

const main = async (): Promise<void> => {
  const repoRoot = process.cwd()
  const typescriptProbe = path.join(repoRoot, TYPESCRIPT_PROBE)
  const rules = await extractRules({
    cwd: repoRoot,
    files: PROBE_FILES.map((file) => path.join(repoRoot, file)),
  })

  const typescriptCount = rules.filter((rule) => rule.enabledFor.includes(typescriptProbe)).length

  // Phase 4 swaps this for `postMigrationAssignment`; that swap is the single place the
  // inventory's meaning changes from "ESLint enforces everything" to the split ownership.
  const markdown = renderInventory(rules, preMigrationAssignment, {
    generatedBy: 'pnpm lint-inventory',
    expectation: {
      label: 'Rules enabled for a TypeScript file',
      count: typescriptCount,
      expected: EXPECTED_TYPESCRIPT_TOTAL,
      source: '`research.md` §2',
    },
  })

  const output = path.join(repoRoot, 'specs/005-oxlint-lint-performance/rule-inventory.md')
  fs.writeFileSync(output, markdown, 'utf8')

  const totals = summarise(rules)
  process.stdout.write(
    `Wrote ${String(totals.total)} rules (${String(totals.typeAware)} type-aware, ${String(totals.syntactic)} syntactic; ${String(typescriptCount)} enabled for a .ts file) to ${path.relative(repoRoot, output)}\n`,
  )

  if (typescriptCount !== EXPECTED_TYPESCRIPT_TOTAL) {
    process.stdout.write(
      `Rules enabled for a TypeScript file is ${String(typescriptCount)}, not the ${String(EXPECTED_TYPESCRIPT_TOTAL)} recorded in research.md §2. Reconcile before relying on the inventory.\n`,
    )
    process.exitCode = 1
  }
}

await main()
