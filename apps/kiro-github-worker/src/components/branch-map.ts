/**
 * Branch map for tracking Worker-created branches.
 *
 * Maintains an in-memory mapping of issue numbers to branch names,
 * enabling identification of Worker-created branches regardless of
 * the configured Branch_Template. Rebuilt from the GitHub API on startup.
 */

import type { Octokit } from '@octokit/rest'
import type pino from 'pino'

// ── Types ───────────────────────────────────────────────────────────

export interface BranchMapInstance {
  get(repoFullName: string, issueNumber: number): string | undefined
  set(repoFullName: string, issueNumber: number, branchName: string): void
  findByBranch(repoFullName: string, branchName: string): number | undefined
  findByPR(repoFullName: string, prNumber: number): number | undefined
  rebuild(octokit: Octokit, allowedRepos: string[] | null): Promise<void>
}

// ── Implementation ──────────────────────────────────────────────────

/**
 * Creates a BranchMap instance that tracks which branches the Worker
 * created for which issues.
 *
 * Storage:
 * - Primary index: `Map<string, Map<number, string>>` (repo → issue → branch)
 * - Secondary index: `Map<string, Map<string, number>>` (repo → branch → issue)
 * - PR index: `Map<string, Map<number, number>>` (repo → prNumber → issueNumber)
 *
 * @param botUsername - The bot's GitHub username for querying PRs
 * @param logger - Pino logger instance
 */
export const createBranchMap = (botUsername: string, logger: pino.Logger): BranchMapInstance => {
  /** repo → issue → branch */
  const primary = new Map<string, Map<number, string>>()
  /** repo → branch → issue */
  const secondary = new Map<string, Map<string, number>>()
  /** repo → prNumber → issueNumber */
  const prIndex = new Map<string, Map<number, number>>()

  const get = (repoFullName: string, issueNumber: number): string | undefined =>
    primary.get(repoFullName)?.get(issueNumber)

  const set = (repoFullName: string, issueNumber: number, branchName: string): void => {
    // Primary index
    let repoIssues = primary.get(repoFullName)
    if (repoIssues == null) {
      repoIssues = new Map()
      primary.set(repoFullName, repoIssues)
    }
    repoIssues.set(issueNumber, branchName)

    // Secondary index
    let repoBranches = secondary.get(repoFullName)
    if (repoBranches == null) {
      repoBranches = new Map()
      secondary.set(repoFullName, repoBranches)
    }
    repoBranches.set(branchName, issueNumber)
  }

  const findByBranch = (repoFullName: string, branchName: string): number | undefined =>
    secondary.get(repoFullName)?.get(branchName)

  const findByPR = (repoFullName: string, prNumber: number): number | undefined =>
    prIndex.get(repoFullName)?.get(prNumber)

  /**
   * Records a PR number → issue number mapping in the PR index.
   */
  const setPR = (repoFullName: string, prNumber: number, issueNumber: number): void => {
    let repoPRs = prIndex.get(repoFullName)
    if (repoPRs == null) {
      repoPRs = new Map()
      prIndex.set(repoFullName, repoPRs)
    }
    repoPRs.set(prNumber, issueNumber)
  }

  /**
   * Extracts an issue number from a PR body using the `Closes #N` pattern.
   * Returns undefined if no match is found.
   */
  const extractIssueNumber = (body: string | null): number | undefined => {
    if (body == null) return undefined
    const match = /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(body)
    return match != null ? Number(match[1]) : undefined
  }

  /**
   * Rebuilds the branch map from the GitHub API on startup.
   *
   * 1. Queries for open PRs authored by BOT_USERNAME across allowed repos
   * 2. Records branch → issue mappings from PR metadata
   * 3. Scans for orphaned branches matching the template pattern and logs warnings
   */
  /**
   * Rebuilds the branch map from the GitHub API on startup.
   *
   * In GitHub App mode, lists repos from the installation and scans
   * open PRs per repo. This avoids the Search API which requires a
   * real GitHub user account. Falls back gracefully on any error.
   */
  const rebuild = async (octokit: Octokit, allowedRepos: string[] | null): Promise<void> => {
    const log = logger.child({ step: 'branch-map-rebuild' })
    log.info('Rebuilding branch map from GitHub API')

    // Clear existing state
    primary.clear()
    secondary.clear()
    prIndex.clear()

    let totalRecorded = 0

    try {
      // Get repos accessible to this installation
      const repos = await listAccessibleRepos(octokit, allowedRepos, log)

      for (const repoFullName of repos) {
        const slashIdx = repoFullName.indexOf('/')
        if (slashIdx === -1) continue
        const owner = repoFullName.slice(0, slashIdx)
        const repo = repoFullName.slice(slashIdx + 1)

        try {
          // List open PRs for this repo and filter by bot author
          let page = 1
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          while (true) {
            const { data: pulls } = await octokit.pulls.list({
              owner,
              repo,
              state: 'open',
              per_page: 100,
              page,
            })

            for (const pr of pulls) {
              // Check if this PR was created by the bot
              const prAuthor = pr.user?.login ?? ''
              if (prAuthor !== botUsername && prAuthor !== `${botUsername}[bot]`) continue

              const ref = pr.head.ref
              const body = pr.body ?? null
              recordPRMapping(repoFullName, pr.number, ref, body, log)
              totalRecorded++
            }

            if (pulls.length < 100) break
            page++
          }
        } catch (err) {
          log.debug({ repo: repoFullName, err }, 'Failed to list PRs for repo')
        }
      }
    } catch (err) {
      log.warn({ err }, 'Branch map rebuild failed (starting with empty map)')
    }

    log.info({ totalRecorded }, 'Branch map rebuild complete')
  }

  /**
   * Lists repositories accessible to the authenticated installation.
   * Uses the installation repos endpoint for App mode, falls back to
   * the allowedRepos list if that fails.
   */
  const listAccessibleRepos = async (
    octokit: Octokit,
    allowedRepos: string[] | null,
    log: pino.Logger,
  ): Promise<string[]> => {
    // If an explicit allowlist is configured, use that directly
    if (allowedRepos != null && allowedRepos.length > 0) {
      return allowedRepos
    }

    // Try to list repos from the App installation
    try {
      const repos: string[] = []
      let page = 1
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      while (true) {
        const { data } = await octokit.apps.listReposAccessibleToInstallation({
          per_page: 100,
          page,
        })

        for (const repo of data.repositories) {
          repos.push(repo.full_name)
        }

        if (data.repositories.length < 100) break
        page++
      }

      log.debug({ repoCount: repos.length }, 'Listed repos from installation')
      return repos
    } catch (err) {
      log.debug({ err }, 'Could not list installation repos (may be PAT mode)')
      return []
    }
  }

  /**
   * Records a PR's branch and issue mapping from PR data.
   */
  const recordPRMapping = (
    repoFullName: string,
    prNumber: number,
    branchName: string,
    body: string | null,
    log: pino.Logger,
  ): void => {
    const issueNumber = extractIssueNumber(body)

    if (issueNumber != null) {
      set(repoFullName, issueNumber, branchName)
      setPR(repoFullName, prNumber, issueNumber)
      log.debug(
        { repo: repoFullName, issueNumber, prNumber, branch: branchName },
        'Recorded PR mapping',
      )
    } else {
      // Orphaned branch — PR exists but no issue number could be extracted
      log.warn(
        { repo: repoFullName, prNumber, branch: branchName },
        'Found open PR with no associated issue number (orphaned branch)',
      )
    }
  }

  return { get, set, findByBranch, findByPR, rebuild }
}
