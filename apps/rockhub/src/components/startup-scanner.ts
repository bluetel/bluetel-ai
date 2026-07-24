/**
 * Startup_Scanner — one-shot enumeration of Watched_Repositories on
 * process start to discover Trigger_Mentions that arrived while
 * Rockhub was offline.
 *
 * `createStartupScanner(deps)` returns `{ scan() }`. The `scan()`
 * method enumerates every Watched_Repository via the GitHub_App
 * installations endpoint, applies the repo filter, then walks seven
 * source-object kinds per repo. For each candidate it checks for an
 * existing `eyes` reaction by the bot; if absent, it builds a
 * RawWebhookEvent-shaped synthesized event, runs it through the SAME
 * eventFilter to derive (sourceType, sourceId), builds a
 * SynthesizedPayload, and offers it to the mentionQueue.
 *
 * Per-repo errors are caught and logged at `warn`; the scan continues
 * with remaining repos. On completion, total enqueued and scanned
 * counts are logged at `info`.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 11.2, 11.3, 11.4
 */

import type { Octokit } from '@octokit/rest'
import type { Logger } from 'pino'

import { buildSynthesizedPayload, matchesBotMention } from '../lib'
import type { RawWebhookEvent, TriggerMention } from '../lib'
import type { SynthesizedPayloadInputs } from '../lib/synthesized-payload'

import type { MentionQueueInstance, QueuedMention } from './mention-queue'

// ── Public Interfaces ──────────────────────────────────────────────

export interface StartupScannerDeps {
  octokit: Octokit
  botUsername: string
  appBotLogin: string // e.g. "my-app-slug[bot]" — derived from GET /app at startup
  repoFilter: (repoFullName: string) => boolean
  eventFilter: (raw: RawWebhookEvent) => TriggerMention | null
  mentionQueue: MentionQueueInstance
  logger: Logger
}

export interface StartupScannerInstance {
  /**
   * Run the scan. Resolves when complete. Per-repo errors are logged
   * and skipped (Req 5.8); the scan does not abort.
   */
  scan: () => Promise<{ enqueued: number; scanned: number }>
}

// ── Factory ────────────────────────────────────────────────────────

export const createStartupScanner = (deps: StartupScannerDeps): StartupScannerInstance => {
  const { octokit, botUsername, appBotLogin, repoFilter, eventFilter, mentionQueue, logger } = deps
  const log = logger.child({ component: 'startup-scanner' })

  const scan = async (): Promise<{ enqueued: number; scanned: number }> => {
    let enqueued = 0
    let scanned = 0

    // Enumerate Watched_Repositories via GitHub App installations endpoint
    const repos = await enumerateWatchedRepos()

    const CONCURRENCY = 10
    const results = await Promise.all(
      chunk(repos, CONCURRENCY).map((batch) =>
        Promise.all(
          batch.map((repo) =>
            scanRepo(repo).catch((err: unknown) => {
              log.warn(
                { repo: repo.full_name, err },
                'Startup scanner error for repository — continuing with remaining repos',
              )
              return { enqueued: 0, scanned: 0 }
            }),
          ),
        ),
      ),
    )
    for (const batch of results) {
      for (const result of batch) {
        enqueued += result.enqueued
        scanned += result.scanned
      }
    }

    log.info({ enqueued, scanned }, 'Startup scan complete')

    return { enqueued, scanned }
  }

  // ── Repository Enumeration ─────────────────────────────────────

  const enumerateWatchedRepos = async (): Promise<RepoInfo[]> => {
    const repos: RepoInfo[] = []

    const iterator = octokit.paginate.iterator(octokit.apps.listReposAccessibleToInstallation, {
      per_page: 100,
    })

    for await (const response of iterator) {
      for (const repo of response.data) {
        const fullName = repo.full_name
        if (repoFilter(fullName)) {
          repos.push({
            full_name: fullName,
            name: repo.name,
            owner: repo.owner.login,
          })
        }
      }
    }

    return repos
  }

  // ── Per-Repo Scan ──────────────────────────────────────────────

  const scanRepo = async (repo: RepoInfo): Promise<{ enqueued: number; scanned: number }> => {
    let enqueued = 0
    let scanned = 0

    const repoRef = { full_name: repo.full_name, name: repo.name, owner: { login: repo.owner } }

    // 1. Open issues with bot mention in body
    const issuesWithMention = await listOpenIssues(repo)
    for (const issue of issuesWithMention) {
      if (issue.pull_request) continue // skip PRs returned by issues endpoint
      const body = issue.body ?? ''
      if (!matchesBotMention(body, botUsername)) continue

      scanned++
      const result = await processCandidate(repo, repoRef, {
        type: 'issue_body',
        issue,
      })
      if (result) enqueued++
    }

    // 2. Open issues assigned to bot
    // Wrapped in try/catch because GitHub returns 422 if the bot user
    // is not a valid assignee (not a collaborator) on the repository.
    try {
      const assignedIssues = await listAssignedIssues(repo)
      for (const issue of assignedIssues) {
        if (issue.pull_request) continue
        scanned++
        const result = await processCandidate(repo, repoRef, {
          type: 'issue_assignment',
          issue,
        })
        if (result) enqueued++
      }
    } catch (err) {
      log.debug(
        { repo: repo.full_name, err },
        'Could not list assigned issues (bot may not be a collaborator) — skipping assignee scan',
      )
    }

    // 3. Open PRs with bot mention in body
    const openPRs = await listOpenPRs(repo)
    for (const pr of openPRs) {
      const body = pr.body ?? ''
      if (matchesBotMention(body, botUsername)) {
        scanned++
        const result = await processCandidate(repo, repoRef, {
          type: 'pr_body',
          pr,
        })
        if (result) enqueued++
      }
    }

    // 4. Open PRs with pending review request to bot
    for (const pr of openPRs) {
      const reviewers = pr.requested_reviewers ?? []
      const botReviewer = reviewers.find(
        (r: { login: string }) => r.login.toLowerCase() === botUsername.toLowerCase(),
      )
      if (botReviewer) {
        scanned++
        const result = await processCandidate(repo, repoRef, {
          type: 'pr_review_request',
          pr,
          reviewer: botReviewer as { login: string; id: number },
        })
        if (result) enqueued++
      }
    }

    // 5. Issue comments mentioning bot (covers both issues and PRs)
    const issueComments = await listIssueComments(repo)
    for (const comment of issueComments) {
      if (!matchesBotMention(comment.body ?? '', botUsername)) continue
      // Skip bot's own comments
      if (comment.user?.login.toLowerCase() === botUsername.toLowerCase()) continue

      scanned++
      const result = await processCandidate(repo, repoRef, {
        type: 'issue_comment',
        comment,
        issueUrl: comment.issue_url,
      })
      if (result) enqueued++
    }

    // 6. PR review comments mentioning bot
    const reviewComments = await listPRReviewComments(repo)
    for (const comment of reviewComments) {
      if (!matchesBotMention(comment.body ?? '', botUsername)) continue
      // Skip bot's own comments
      if (comment.user?.login.toLowerCase() === botUsername.toLowerCase()) continue

      scanned++
      const result = await processCandidate(repo, repoRef, {
        type: 'pr_review_comment',
        comment,
        prUrl: comment.pull_request_url,
      })
      if (result) enqueued++
    }

    return { enqueued, scanned }
  }

  // ── Candidate Processing ───────────────────────────────────────

  const processCandidate = async (
    repo: RepoInfo,
    repoRef: { full_name: string; name: string; owner: { login: string } },
    candidate: ScanCandidate,
  ): Promise<boolean> => {
    // Check for existing eyes reaction
    const hasEyes = await checkEyesReaction(repo, candidate)
    if (hasEyes) {
      log.debug(
        { repo: repo.full_name, candidateType: candidate.type },
        'Startup scanner skipped — eyes reaction already present',
      )
      return false
    }

    // Build a RawWebhookEvent and run through eventFilter
    const rawEvent = buildRawEvent(repoRef, candidate)
    if (!rawEvent) return false

    const mention = eventFilter(rawEvent)
    if (!mention) return false

    // Build SynthesizedPayload
    const inputs = buildPayloadInputs(repoRef, candidate)
    const payload = buildSynthesizedPayload(mention, inputs)

    // Offer to mentionQueue
    const item: QueuedMention = {
      mention,
      payload,
      eventName: `${mention.sourceType}.synthesized`,
      deliveryId: `startup-scan-${mention.identity}`,
    }

    return mentionQueue.offer(item)
  }

  // ── Eyes Reaction Check ────────────────────────────────────────

  const checkEyesReaction = async (repo: RepoInfo, candidate: ScanCandidate): Promise<boolean> => {
    try {
      const reactions = await fetchReactions(repo, candidate)
      return reactions.some(
        (r) =>
          r.content === 'eyes' &&
          (r.user?.login.toLowerCase() === botUsername.toLowerCase() ||
            r.user?.login.toLowerCase() === appBotLogin.toLowerCase()),
      )
    } catch {
      // If we can't fetch reactions, assume not processed
      return false
    }
  }

  const fetchReactions = async (
    repo: RepoInfo,
    candidate: ScanCandidate,
  ): Promise<Array<{ content: string; user?: { login: string } | null }>> => {
    const owner = repo.owner
    const repoName = repo.name

    switch (candidate.type) {
      case 'issue_body':
      case 'issue_assignment':
        return await paginateReactions(() =>
          octokit.reactions.listForIssue({
            owner,
            repo: repoName,
            issue_number: candidate.issue.number,
            per_page: 100,
          }),
        )

      case 'pr_body':
      case 'pr_review_request':
        return await paginateReactions(() =>
          octokit.reactions.listForIssue({
            owner,
            repo: repoName,
            issue_number: candidate.pr.number,
            per_page: 100,
          }),
        )

      case 'issue_comment':
        return await paginateReactions(() =>
          octokit.reactions.listForIssueComment({
            owner,
            repo: repoName,
            comment_id: candidate.comment.id,
            per_page: 100,
          }),
        )

      case 'pr_review_comment':
        return await paginateReactions(() =>
          octokit.reactions.listForPullRequestReviewComment({
            owner,
            repo: repoName,
            comment_id: candidate.comment.id,
            per_page: 100,
          }),
        )
    }
  }

  const paginateReactions = async (
    fetcher: () => Promise<{ data: Array<{ content: string; user?: { login: string } | null }> }>,
  ): Promise<Array<{ content: string; user?: { login: string } | null }>> => {
    const response = await fetcher()
    return response.data
  }

  // ── RawWebhookEvent Builder ────────────────────────────────────

  const buildRawEvent = (
    repoRef: { full_name: string; name: string; owner: { login: string } },
    candidate: ScanCandidate,
  ): RawWebhookEvent | null => {
    const repository = repoRef

    switch (candidate.type) {
      case 'issue_body':
        return {
          name: 'issues.opened',
          payload: {
            action: 'opened',
            repository,
            issue: {
              number: candidate.issue.number,
              title: candidate.issue.title,
              body: candidate.issue.body ?? null,
              user: { login: candidate.issue.user?.login ?? '', id: candidate.issue.user?.id ?? 0 },
            },
            sender: { login: candidate.issue.user?.login ?? '', id: candidate.issue.user?.id ?? 0 },
          },
        }

      case 'issue_assignment':
        return {
          name: 'issues.assigned',
          payload: {
            action: 'assigned',
            repository,
            issue: {
              number: candidate.issue.number,
              title: candidate.issue.title,
              body: candidate.issue.body ?? null,
              user: { login: candidate.issue.user?.login ?? '', id: candidate.issue.user?.id ?? 0 },
            },
            assignee: { login: botUsername, id: 0 },
            sender: { login: candidate.issue.user?.login ?? '', id: candidate.issue.user?.id ?? 0 },
          },
        }

      case 'pr_body':
        return {
          name: 'pull_request.opened',
          payload: {
            action: 'opened',
            repository,
            pull_request: {
              number: candidate.pr.number,
              title: candidate.pr.title,
              body: candidate.pr.body ?? null,
              user: { login: candidate.pr.user?.login ?? '', id: candidate.pr.user?.id ?? 0 },
            },
            sender: { login: candidate.pr.user?.login ?? '', id: candidate.pr.user?.id ?? 0 },
          },
        }

      case 'pr_review_request':
        return {
          name: 'pull_request.review_requested',
          payload: {
            action: 'review_requested',
            repository,
            pull_request: {
              number: candidate.pr.number,
              title: candidate.pr.title,
              body: candidate.pr.body ?? null,
              user: { login: candidate.pr.user?.login ?? '', id: candidate.pr.user?.id ?? 0 },
              requested_reviewers: [{ login: candidate.reviewer.login, id: candidate.reviewer.id }],
            },
            requested_reviewer: { login: candidate.reviewer.login, id: candidate.reviewer.id },
            sender: { login: candidate.pr.user?.login ?? '', id: candidate.pr.user?.id ?? 0 },
          },
        }

      case 'issue_comment': {
        // Determine if this is on a PR or an issue based on the issue_url
        const isPr = candidate.issueUrl.includes('/pull/')
        return {
          name: 'issue_comment.created',
          payload: {
            action: 'created',
            repository,
            issue: {
              number: extractNumberFromUrl(candidate.issueUrl),
              title: '',
              body: null,
              user: { login: '', id: 0 },
              ...(isPr ? { pull_request: { url: candidate.issueUrl } } : {}),
            },
            comment: {
              id: candidate.comment.id,
              body: candidate.comment.body ?? '',
              user: {
                login: candidate.comment.user?.login ?? '',
                id: candidate.comment.user?.id ?? 0,
              },
            },
            sender: {
              login: candidate.comment.user?.login ?? '',
              id: candidate.comment.user?.id ?? 0,
            },
          },
        }
      }

      case 'pr_review_comment': {
        const prNumber = extractNumberFromUrl(candidate.prUrl)
        return {
          name: 'pull_request_review_comment.created',
          payload: {
            action: 'created',
            repository,
            pull_request: {
              number: prNumber,
              title: '',
              body: null,
              user: { login: '', id: 0 },
            },
            comment: {
              id: candidate.comment.id,
              body: candidate.comment.body ?? '',
              user: {
                login: candidate.comment.user?.login ?? '',
                id: candidate.comment.user?.id ?? 0,
              },
            },
            sender: {
              login: candidate.comment.user?.login ?? '',
              id: candidate.comment.user?.id ?? 0,
            },
          },
        }
      }
    }
  }

  // ── SynthesizedPayloadInputs Builder ───────────────────────────

  const buildPayloadInputs = (
    repoRef: { full_name: string; name: string; owner: { login: string } },
    candidate: ScanCandidate,
  ): SynthesizedPayloadInputs => {
    const base: SynthesizedPayloadInputs = { repository: repoRef }

    switch (candidate.type) {
      case 'issue_body':
        return {
          ...base,
          issue: {
            number: candidate.issue.number,
            title: candidate.issue.title,
            body: candidate.issue.body ?? null,
            user: { login: candidate.issue.user?.login ?? '' },
          },
        }

      case 'issue_assignment':
        return {
          ...base,
          issue: {
            number: candidate.issue.number,
            title: candidate.issue.title,
            body: candidate.issue.body ?? null,
            user: { login: candidate.issue.user?.login ?? '' },
          },
          assignee: { login: botUsername },
        }

      case 'pr_body':
        return {
          ...base,
          pull_request: {
            number: candidate.pr.number,
            title: candidate.pr.title,
            body: candidate.pr.body ?? null,
            user: { login: candidate.pr.user?.login ?? '' },
          },
        }

      case 'pr_review_request':
        return {
          ...base,
          pull_request: {
            number: candidate.pr.number,
            title: candidate.pr.title,
            body: candidate.pr.body ?? null,
            user: { login: candidate.pr.user?.login ?? '' },
          },
          requested_reviewer: { login: candidate.reviewer.login, id: candidate.reviewer.id },
        }

      case 'issue_comment': {
        const isPr = candidate.issueUrl.includes('/pull/')
        const issueNumber = extractNumberFromUrl(candidate.issueUrl)
        return {
          ...base,
          issue: {
            number: issueNumber,
            title: '',
            body: null,
            user: { login: '' },
          },
          comment: {
            id: candidate.comment.id,
            body: candidate.comment.body ?? '',
            user: { login: candidate.comment.user?.login ?? '' },
          },
          // For pr_comment source type, the issue field is still used
          // (GitHub delivers PR comments as issue_comment events)
          ...(isPr ? {} : {}),
        }
      }

      case 'pr_review_comment': {
        const prNumber = extractNumberFromUrl(candidate.prUrl)
        return {
          ...base,
          pull_request: {
            number: prNumber,
            title: '',
            body: null,
            user: { login: '' },
          },
          comment: {
            id: candidate.comment.id,
            body: candidate.comment.body ?? '',
            user: { login: candidate.comment.user?.login ?? '' },
          },
        }
      }
    }
  }

  // ── GitHub API Helpers ─────────────────────────────────────────

  const listOpenIssues = async (repo: RepoInfo): Promise<IssueItem[]> => {
    const items: IssueItem[] = []
    const iterator = octokit.paginate.iterator(octokit.issues.listForRepo, {
      owner: repo.owner,
      repo: repo.name,
      state: 'open',
      per_page: 100,
    })
    for await (const response of iterator) {
      items.push(...(response.data as IssueItem[]))
    }
    return items
  }

  const listAssignedIssues = async (repo: RepoInfo): Promise<IssueItem[]> => {
    const items: IssueItem[] = []
    const iterator = octokit.paginate.iterator(octokit.issues.listForRepo, {
      owner: repo.owner,
      repo: repo.name,
      state: 'open',
      assignee: botUsername,
      per_page: 100,
    })
    for await (const response of iterator) {
      items.push(...(response.data as IssueItem[]))
    }
    return items
  }

  const listOpenPRs = async (repo: RepoInfo): Promise<PRItem[]> => {
    const items: PRItem[] = []
    const iterator = octokit.paginate.iterator(octokit.pulls.list, {
      owner: repo.owner,
      repo: repo.name,
      state: 'open',
      per_page: 100,
    })
    for await (const response of iterator) {
      items.push(...(response.data as PRItem[]))
    }
    return items
  }

  const listIssueComments = async (repo: RepoInfo): Promise<IssueCommentItem[]> => {
    const items: IssueCommentItem[] = []
    const iterator = octokit.paginate.iterator(octokit.issues.listCommentsForRepo, {
      owner: repo.owner,
      repo: repo.name,
      per_page: 100,
    })
    for await (const response of iterator) {
      items.push(...(response.data as IssueCommentItem[]))
    }
    return items
  }

  const listPRReviewComments = async (repo: RepoInfo): Promise<PRReviewCommentItem[]> => {
    const items: PRReviewCommentItem[] = []
    const iterator = octokit.paginate.iterator(octokit.pulls.listReviewCommentsForRepo, {
      owner: repo.owner,
      repo: repo.name,
      per_page: 100,
    })
    for await (const response of iterator) {
      items.push(...(response.data as PRReviewCommentItem[]))
    }
    return items
  }

  // ── Utility ────────────────────────────────────────────────────

  const chunk = <T>(arr: T[], size: number): T[][] => {
    const chunks: T[][] = []
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size))
    return chunks
  }

  const extractNumberFromUrl = (url: string): number => {
    const parts = url.split('/')
    const last = parts[parts.length - 1]
    return parseInt(last, 10) || 0
  }

  return { scan }
}

// ── Internal Types ─────────────────────────────────────────────────

interface RepoInfo {
  full_name: string
  name: string
  owner: string
}

interface IssueItem {
  number: number
  title: string
  body: string | null
  user?: { login: string; id: number } | null
  pull_request?: { url?: string } | null
}

interface PRItem {
  number: number
  title: string
  body: string | null
  user?: { login: string; id: number } | null
  requested_reviewers?: Array<{ login: string; id: number }> | null
}

interface IssueCommentItem {
  id: number
  body?: string
  user?: { login: string; id: number } | null
  issue_url: string
}

interface PRReviewCommentItem {
  id: number
  body?: string
  user?: { login: string; id: number } | null
  pull_request_url: string
}

type ScanCandidate =
  | { type: 'issue_body'; issue: IssueItem }
  | { type: 'issue_assignment'; issue: IssueItem }
  | { type: 'pr_body'; pr: PRItem }
  | { type: 'pr_review_request'; pr: PRItem; reviewer: { login: string; id: number } }
  | { type: 'issue_comment'; comment: IssueCommentItem; issueUrl: string }
  | { type: 'pr_review_comment'; comment: PRReviewCommentItem; prUrl: string }
