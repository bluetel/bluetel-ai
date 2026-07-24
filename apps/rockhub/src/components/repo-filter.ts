/**
 * Repository allowlist/denylist filter.
 *
 * Determines whether a webhook event from a given repository should be
 * accepted based on optional allowlist and denylist configuration.
 *
 * Evaluation order:
 * 1. If `allowedRepos` is set and the repo is not in the list → reject
 * 2. If `deniedRepos` is set and the repo is in the list → reject
 * 3. If neither is configured → accept all repos
 *
 * Skipped repos are logged at `debug` level.
 */

import type pino from 'pino'

export interface RepoFilterConfig {
  allowedRepos: string[] | null
  deniedRepos: string[] | null
}

/**
 * Creates a repo filter function bound to the given config and logger.
 *
 * @param config - Allowlist/denylist configuration
 * @param logger - Pino logger instance for debug-level rejection logging
 * @returns A function that returns `true` if the repo should be processed
 */
export const createRepoFilter = (
  config: RepoFilterConfig,
  logger: pino.Logger,
): ((repoFullName: string) => boolean) => {
  const shouldProcessRepo = (repoFullName: string): boolean => {
    // Allowlist check first
    if (config.allowedRepos != null && !config.allowedRepos.includes(repoFullName)) {
      logger.debug({ repo: repoFullName }, 'Repo not in allowlist, skipping')
      return false
    }

    // Denylist check second
    if (config.deniedRepos?.includes(repoFullName)) {
      logger.debug({ repo: repoFullName }, 'Repo in denylist, skipping')
      return false
    }

    return true
  }

  return shouldProcessRepo
}
