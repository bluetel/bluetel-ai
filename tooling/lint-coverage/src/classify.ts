/**
 * Pure helpers for turning an ESLint flat-config rule entry into an inventory row.
 *
 * Kept free of any ESLint or filesystem access so they can be tested directly — the
 * IO-bearing half lives in `extract.ts`.
 */

/** Which layer is responsible for enforcing a rule after the migration. */
export type RuleOwner =
  | 'oxlint-native'
  | 'oxlint-js-plugin'
  | 'oxlint-type-aware'
  /** The full ESLint layer as it stands before the migration — the pre-Phase-4 owner of everything. */
  | 'eslint'
  /** The reduced, Nx-only ESLint target that survives the migration. */
  | 'eslint-workspace'
  | 'other'
  | 'unassigned'

/** What happened to a rule across the migration. */
export type RuleStatus = 'covered' | 'relocated' | 'dropped' | 'unassigned'

/**
 * A rule entry as it appears in a resolved flat config: either a bare severity, or a
 * tuple of severity followed by that rule's options.
 */
export type RuleEntry = number | string | readonly unknown[]

export type Severity = 'off' | 'warn' | 'error'

const SEVERITY_BY_NUMBER: Record<number, Severity> = { 0: 'off', 1: 'warn', 2: 'error' }

/**
 * Whether a rule entry is the `[severity, ...options]` tuple form.
 *
 * A hand-written guard rather than a bare `Array.isArray`, which widens a `readonly
 * unknown[]` to `any[]` and takes the rest of the function's type safety with it.
 */
const isTuple = (entry: RuleEntry): entry is readonly unknown[] => Array.isArray(entry)

/**
 * Normalise the severity of a rule entry to a string, whichever of the four shapes
 * ESLint hands back (`2`, `'error'`, `[2, {...}]`, `['error', {...}]`).
 */
export const severityOf = (entry: RuleEntry): Severity => {
  const head = isTuple(entry) ? (entry[0] as number | string | undefined) : entry
  if (typeof head === 'number') return SEVERITY_BY_NUMBER[head] ?? 'off'
  if (head === 'warn' || head === 'error' || head === 'off') return head
  return 'off'
}

/** A rule is enforced when its severity is anything other than `off`. */
export const isEnabled = (entry: RuleEntry): boolean => severityOf(entry) !== 'off'

/** The options a rule was configured with, or `[]` when it was given a bare severity. */
export const optionsOf = (entry: RuleEntry): unknown[] => (isTuple(entry) ? [...entry.slice(1)] : [])

/**
 * The plugin a rule belongs to, derived from its name.
 *
 * Core ESLint rules carry no prefix and are reported as `eslint`. Everything else is
 * namespaced by its plugin, and scoped plugin names may themselves contain a slash
 * (`@typescript-eslint/no-floating-promises`, `import-x/order`), so the split is on the
 * *last* slash rather than the first.
 */
export const pluginOf = (ruleName: string): string => {
  const lastSlash = ruleName.lastIndexOf('/')
  return lastSlash === -1 ? 'eslint' : ruleName.slice(0, lastSlash)
}

/** The rule's own name within its plugin, i.e. the name minus the plugin prefix. */
export const shortNameOf = (ruleName: string): string => {
  const lastSlash = ruleName.lastIndexOf('/')
  return lastSlash === -1 ? ruleName : ruleName.slice(lastSlash + 1)
}

/**
 * Whether a rule needs type information to run.
 *
 * Read from the rule's own `meta.docs.requiresTypeChecking` rather than from a
 * hand-maintained list — a list would go stale the first time typescript-eslint
 * reclassified a rule, and the whole point of this harness is to not be told a
 * comforting story about coverage.
 */
export const requiresTypeChecking = (meta: RuleMeta | undefined): boolean =>
  meta?.docs?.requiresTypeChecking === true

/** Whether ESLint can auto-fix violations of the rule, as opposed to only reporting them. */
export const isFixable = (meta: RuleMeta | undefined): boolean => typeof meta?.fixable === 'string'

/** The subset of an ESLint rule's `meta` this harness reads. */
export interface RuleMeta {
  fixable?: string | null
  hasSuggestions?: boolean
  docs?: {
    description?: string
    requiresTypeChecking?: boolean
    url?: string
  }
}
