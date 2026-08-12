import type { ExtractedRule } from './extract'
import type { RuleAssignment } from './inventory'

/**
 * Rules that stay with ESLint after the migration, and why.
 *
 * Everything else moves to oxlint. Keeping the exceptions listed — rather than the
 * majority — means a rule can only stay behind deliberately, and the reason is recorded
 * next to it rather than in a commit message nobody will read again.
 */
export const ESLINT_WORKSPACE_RULES: Readonly<Partial<Record<string, string>>> = {
  '@nx/enforce-module-boundaries':
    'Needs the Nx project graph, which only exists inside an Nx invocation. Also silently skipped on the pre-migration staged path — see research.md §1.',
  '@cspell/spellchecker':
    'No oxlint equivalent. 1555 ms per invocation, none of it scaling with file count, so it belongs to a cached per-project target.',
}

/**
 * Rules with no native oxlint implementation, which run through oxlint's ESLint-v9-compatible
 * JS plugin API instead. Confirmed by task T013 against `oxlint --rules`.
 */
export const OXLINT_JS_PLUGIN_RULES: Readonly<Partial<Record<string, string>>> = {}

/**
 * The assignment table before Phase 4: ESLint enforces every rule, and does so today.
 *
 * This is the honest pre-migration state, and it is what makes the Phase 2 harness a real
 * baseline — the suite has to pass against the setup as it exists, not against the one the
 * migration intends to produce.
 */
export const preMigrationAssignment = (): RuleAssignment => ({
  owner: 'eslint',
  status: 'covered',
  notes: 'Pre-migration: the single ESLint layer enforces every rule.',
})

/**
 * The assignment table after Phase 4. Type-aware rules go to `oxlint-tsgolint`, the two
 * workspace-scoped rules stay with ESLint, rules with no native oxlint implementation go
 * through the JS plugin API, and everything else is a native oxlint rule.
 */
export const postMigrationAssignment = (rule: ExtractedRule): RuleAssignment => {
  const eslintReason = ESLINT_WORKSPACE_RULES[rule.name]
  if (eslintReason !== undefined) {
    return { owner: 'eslint-workspace', status: 'relocated', notes: eslintReason }
  }

  const jsPluginReason = OXLINT_JS_PLUGIN_RULES[rule.name]
  if (jsPluginReason !== undefined) {
    return { owner: 'oxlint-js-plugin', status: 'relocated', notes: jsPluginReason }
  }

  if (rule.requiresTypeChecking) {
    return {
      owner: 'oxlint-type-aware',
      status: 'relocated',
      notes: 'Runs under oxlint-tsgolint, which embeds its own typechecker.',
    }
  }

  return { owner: 'oxlint-native', status: 'relocated' }
}
