/**
 * The FR-040 ceiling, read from deploy-time configuration.
 *
 * Kept beside admission rather than inside it so the value under test is always the value passed
 * in: {@link import('./admit-workflow').admitWorkflow} takes a number, and this module is the only
 * place that decides what that number is in production.
 *
 * **Where this belongs eventually.** `SISYPHUS_CONCURRENCY_CEILING` is deploy-time configuration
 * and its permanent home is `env-schemas.ts`, alongside the buckets and the scheduler ARNs, so a
 * malformed value fails at boot naming the variable. That file was outside the scope of this
 * change, so the variable is parsed here with the same strictness the schema would apply, and the
 * move is a one-line addition there plus deleting this reader.
 */

/** The environment variable holding the platform-wide ceiling. */
export const CONCURRENCY_CEILING_VARIABLE = 'SISYPHUS_CONCURRENCY_CEILING'

/**
 * Used when the variable is absent.
 *
 * Deliberately small. A platform nobody has configured should queue and be noticed, not provision
 * as much compute as work arrives — the failure mode of a too-low ceiling is a visible wait with a
 * queue position, and the failure mode of a too-high one is a bill.
 */
export const DEFAULT_CONCURRENCY_CEILING = 5

/**
 * The configured ceiling.
 *
 * A blank or whitespace-only value counts as absent, because a variable exported as `''` by
 * misconfigured deploy tooling is not a considered choice of ceiling. Anything else present must
 * parse as a positive integer: a typo becomes a startup failure naming the variable rather than a
 * silent fallback that quietly provisions under a different bound than the operator set.
 *
 * @param environment - Defaults to the process environment; injectable so this is testable.
 * @throws If the variable is present but not a positive integer.
 */
export const readConcurrencyCeiling = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number => {
  const raw = environment[CONCURRENCY_CEILING_VARIABLE]?.trim()

  if (raw === undefined || raw === '') {
    return DEFAULT_CONCURRENCY_CEILING
  }

  // Digits only, rather than `Number(raw)`: that would read `1e3` as a thousand instances and
  // `0x10` as sixteen, and a ceiling is not a place to be relaxed about what a number looks like.
  const parsed = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `${CONCURRENCY_CEILING_VARIABLE} must be a positive integer; received "${raw}". Falling back to a default here would run the platform under a bound nobody chose.`,
    )
  }

  return parsed
}
