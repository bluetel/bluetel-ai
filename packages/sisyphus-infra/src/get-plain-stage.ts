/**
 * SST stage-name suffixes used by the auxiliary stages that deploy alongside a
 * plain stage. `<stage>-bootstrap` provisions the account-level, once-per-stage
 * resources; `<stage>-website` deploys the panel. Both must resolve back to the
 * same plain stage so they read and write the same per-stage parameters.
 */
export const BOOTSTRAP_STAGE_SUFFIX = '-bootstrap'

export const WEBSITE_STAGE_SUFFIX = '-website'

const KNOWN_STAGE_SUFFIXES = [BOOTSTRAP_STAGE_SUFFIX, WEBSITE_STAGE_SUFFIX] as const

/**
 * Whether this is the auxiliary stage that provisions the account-level
 * resources. Exported so a `sst.config.ts` branches on the vocabulary declared
 * here rather than on a suffix spelled out at the call site.
 */
export const isBootstrapStage = (sstStage: string): boolean =>
  sstStage.endsWith(BOOTSTRAP_STAGE_SUFFIX)

/**
 * Extracts the plain stage name from an SST stage name by stripping a known
 * auxiliary suffix. Returns the input unchanged when no suffix matches, so the
 * function is safe to apply to any stage name and is idempotent.
 *
 * @example
 * getPlainStage('production-bootstrap') // → 'production'
 * getPlainStage('staging-website')      // → 'staging'
 * getPlainStage('staging')              // → 'staging'
 */
export const getPlainStage = (sstStage: string): string => {
  for (const suffix of KNOWN_STAGE_SUFFIXES) {
    if (sstStage.endsWith(suffix)) {
      return sstStage.slice(0, -suffix.length)
    }
  }

  return sstStage
}
