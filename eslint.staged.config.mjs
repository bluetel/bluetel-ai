import { base, withTypeChecking } from '@bluetel-ai/eslint-config-base'

/**
 * The config `lint-staged` resolves for the per-file pass.
 *
 * Identical to every project's `eslint.config.mjs` except that it omits `workspaceChecks` —
 * the rules whose cost does not scale with the number of files being linted, and which are
 * therefore enforced once per project by the Nx `lint` target instead. Today that is
 * `@cspell/spellchecker` at ~1555 ms per invocation.
 *
 * Nothing is dropped: every rule here is still enforced, and every rule omitted here is
 * enforced by the project-level run. See specs/005-oxlint-lint-performance/plan.md.
 */
export default [...base, ...withTypeChecking(import.meta.dirname)]
