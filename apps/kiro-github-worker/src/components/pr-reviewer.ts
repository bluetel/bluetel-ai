/**
 * PR reviewer for handling review comments and change requests.
 *
 * Handles three types of PR feedback events on Worker-created PRs:
 * - Review comments (inline code comments with bot mention)
 * - Changes requested (full review with `changes_requested` state)
 * - PR comments (general issue-style comments on a PR with bot mention)
 *
 * For each event the reviewer clones the repo, checks out the PR branch,
 * constructs a prompt with the review context, and invokes the Kiro CLI.
 * The Kiro CLI is responsible for all git operations (commit, push) and
 * posting reply comments on the PR. After Kiro CLI completes, the reviewer
 * verifies that commits were pushed via PR_Manager.verifyPushedCommits.
 *
 * The setup script (rocky.sh) is executed by the Repo_Cloner after clone
 * and before control returns to the reviewer for Kiro CLI invocation.
 *
 * Factory function `createPRReviewer` returns the three handler functions
 * bound to the given dependencies and logger.
 */

import type { Octokit } from '@octokit/rest'
import type pino from 'pino'

import { buildPRReviewPrompt, resolveWebhookAgent } from '../lib/prompt-builder'
import type { Engine, ExecutionResult, ReviewComment } from '../lib/types'
import { COMMENT_MARKER } from '../lib/types'

import { postPRFeedbackError } from './issue-commenter'
import type { createPRManager } from './pr-manager'
import type { createRepoCloner } from './repo-cloner'
import type { SessionLogWriterInstance } from './session-log-writer'

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Returns `true` when the comment/review was authored by the bot itself,
 * detected via the `<!-- rocky-worker -->` marker or author username match.
 */
const isBotComment = (body: string, author: string, botUsername: string): boolean =>
  body.includes(COMMENT_MARKER) || author === botUsername

// ── Types ───────────────────────────────────────────────────────────

interface ExecutorRouterInstance {
  execute: (
    workingDir: string,
    prompt: string,
    options?: {
      engine?: Engine
      agent?: string
      context?: {
        engine: Engine
        repoFullName: string
        executionContext?: string
      }
    },
  ) => Promise<ExecutionResult>
}

export interface PRReviewerDeps {
  repoCloner: ReturnType<typeof createRepoCloner>
  executorRouter: ExecutorRouterInstance
  sessionLogWriter: SessionLogWriterInstance
  prManager: ReturnType<typeof createPRManager>
  logger: pino.Logger
  defaultAgent?: string
}

export interface HandleReviewCommentParams {
  octokit: Octokit
  token: string
  repoFullName: string
  prNumber: number
  issueNumber: number | null
  commentBody: string
  commentAuthor: string
  filePath: string
  lineContext: string
  branchName: string
  issueTitle: string
  issueBody: string
  botUsername: string
  jobId: string
}

export interface HandleChangesRequestedParams {
  octokit: Octokit
  token: string
  repoFullName: string
  prNumber: number
  issueNumber: number | null
  reviewBody: string
  reviewAuthor: string
  reviewComments: ReviewComment[]
  branchName: string
  issueTitle: string
  issueBody: string
  botUsername: string
  jobId: string
}

export interface HandlePRCommentParams {
  octokit: Octokit
  token: string
  repoFullName: string
  prNumber: number
  issueNumber: number | null
  commentBody: string
  commentAuthor: string
  branchName: string
  issueTitle: string
  issueBody: string
  botUsername: string
  jobId: string
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Creates a PR reviewer bound to the given dependencies and logger.
 *
 * The reviewer delegates all git operations (commit, push) and PR reply
 * comments to the Kiro CLI. After Kiro CLI completes, it verifies that
 * commits were pushed via PR_Manager.verifyPushedCommits.
 *
 * @param deps - Repo cloner, Kiro executor, PR manager, and logger
 * @returns Object with `handleReviewComment`, `handleChangesRequested`,
 *          and `handlePRComment` functions
 */
export const createPRReviewer = (
  deps: PRReviewerDeps,
): {
  handleReviewComment: (params: HandleReviewCommentParams) => Promise<void>
  handleChangesRequested: (params: HandleChangesRequestedParams) => Promise<void>
  handlePRComment: (params: HandlePRCommentParams) => Promise<void>
} => {
  const { repoCloner, executorRouter, sessionLogWriter, prManager, logger, defaultAgent } = deps

  // ── handleReviewComment ─────────────────────────────────────────

  /**
   * Handles an inline review comment on a Worker-created PR.
   *
   * Clones the repo (setup script runs automatically during clone),
   * checks out the PR branch, constructs a prompt with the review
   * comment context (file path, line, body), and invokes the Kiro CLI.
   * The Kiro CLI handles committing, pushing, and posting a reply
   * comment on the PR. After completion, verifies pushed commits via
   * PR_Manager.verifyPushedCommits.
   */
  const handleReviewComment = async (params: HandleReviewCommentParams): Promise<void> => {
    const {
      octokit,
      token,
      repoFullName,
      prNumber,
      issueNumber,
      commentBody,
      commentAuthor,
      filePath,
      lineContext,
      branchName,
      issueTitle,
      issueBody,
      botUsername,
      jobId,
    } = params

    const log = logger.child({
      repo: repoFullName,
      prNumber,
      issueNumber,
      step: 'review-comment',
    })

    // Loop prevention: ignore bot's own comments
    if (isBotComment(commentBody, commentAuthor, botUsername)) {
      log.debug('Ignoring bot-authored review comment')
      return
    }

    let workingDir: string | undefined

    try {
      // Clone and checkout the PR branch
      const cloneResult = await repoCloner.cloneForFollowUp(
        repoFullName,
        issueNumber ?? prNumber,
        branchName,
        token,
        octokit,
      )
      workingDir = cloneResult.workingDir

      // Write session log for rocky.sh output so it appears in admin dashboard
      if (cloneResult.setupScriptResult != null) {
        void sessionLogWriter.writeSessionLog(
          {
            success: cloneResult.setupScriptResult.exitCode === 0,
            hasChanges: false,
            stdout: cloneResult.setupScriptResult.stdout,
            stderr: cloneResult.setupScriptResult.stderr,
            exitCode: cloneResult.setupScriptResult.exitCode,
          },
          {
            engine: 'kiro',
            repoFullName,
            executionContext: `setup-task-${jobId}`,
          },
        )
      }

      // Build feedback text including file path and line context
      const feedback = `Review comment on file \`${filePath}\`${lineContext ? ` (line context: ${lineContext})` : ''}:\n\n${commentBody}`

      const prompt = buildPRReviewPrompt(
        issueTitle,
        issueBody,
        feedback,
        repoFullName,
        issueNumber ?? 0,
        prNumber,
      )

      log.info('Invoking Kiro CLI for review comment')
      const result = await executorRouter.execute(workingDir, prompt, {
        agent: resolveWebhookAgent(issueBody, commentBody, defaultAgent),
        context: {
          engine: 'kiro',
          repoFullName,
          executionContext: `task-${jobId}`,
        },
      })

      if (!result.success) {
        log.error({ exitCode: result.exitCode }, 'Kiro CLI failed for review comment')
        await postPRFeedbackError(
          octokit,
          repoFullName,
          prNumber,
          result.stderr || 'Kiro CLI failed',
        )
        return
      }

      // Verify Kiro CLI pushed commits to the remote branch
      const pushed = await prManager.verifyPushedCommits({
        repoFullName,
        branchName,
        workingDir,
      })

      if (!pushed) {
        log.warn('Kiro CLI completed but no pushed commits detected for review comment')
      }

      log.info({ pushed }, 'Kiro CLI completed for review comment')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error({ error: message }, 'Failed to handle review comment')
      await postPRFeedbackError(octokit, repoFullName, prNumber, message)
    } finally {
      if (workingDir) {
        await repoCloner.cleanup(workingDir)
      }
    }
  }

  // ── handleChangesRequested ──────────────────────────────────────

  /**
   * Handles a `changes_requested` review on a Worker-created PR.
   *
   * Clones the repo (setup script runs automatically during clone),
   * checks out the PR branch, constructs a prompt with the full review
   * body and all individual review comments, and invokes the Kiro CLI.
   * The Kiro CLI handles committing, pushing, and posting a reply
   * comment on the PR. After completion, verifies pushed commits via
   * PR_Manager.verifyPushedCommits.
   */
  const handleChangesRequested = async (params: HandleChangesRequestedParams): Promise<void> => {
    const {
      octokit,
      token,
      repoFullName,
      prNumber,
      issueNumber,
      reviewBody,
      reviewAuthor,
      reviewComments,
      branchName,
      issueTitle,
      issueBody,
      botUsername,
      jobId,
    } = params

    const log = logger.child({
      repo: repoFullName,
      prNumber,
      issueNumber,
      step: 'changes-requested',
    })

    // Loop prevention: ignore bot's own reviews
    if (isBotComment(reviewBody, reviewAuthor, botUsername)) {
      log.debug('Ignoring bot-authored review')
      return
    }

    let workingDir: string | undefined

    try {
      // Clone and checkout the PR branch
      const cloneResult = await repoCloner.cloneForFollowUp(
        repoFullName,
        issueNumber ?? prNumber,
        branchName,
        token,
        octokit,
      )
      workingDir = cloneResult.workingDir

      // Write session log for rocky.sh output so it appears in admin dashboard
      if (cloneResult.setupScriptResult != null) {
        void sessionLogWriter.writeSessionLog(
          {
            success: cloneResult.setupScriptResult.exitCode === 0,
            hasChanges: false,
            stdout: cloneResult.setupScriptResult.stdout,
            stderr: cloneResult.setupScriptResult.stderr,
            exitCode: cloneResult.setupScriptResult.exitCode,
          },
          {
            engine: 'kiro',
            repoFullName,
            executionContext: `setup-task-${jobId}`,
          },
        )
      }

      // Build feedback text with review body and all review comments
      const commentDetails = reviewComments
        .map(
          (c) =>
            `- File: \`${c.path}\`${c.line != null ? ` (line ${String(c.line)})` : ''}: ${c.body}`,
        )
        .join('\n')

      const feedback = [
        reviewBody ? `Review body: ${reviewBody}` : '',
        commentDetails ? `\nReview comments:\n${commentDetails}` : '',
      ]
        .filter(Boolean)
        .join('\n')

      const prompt = buildPRReviewPrompt(
        issueTitle,
        issueBody,
        feedback,
        repoFullName,
        issueNumber ?? 0,
        prNumber,
      )

      log.info({ commentCount: reviewComments.length }, 'Invoking Kiro CLI for changes requested')
      const result = await executorRouter.execute(workingDir, prompt, {
        agent: resolveWebhookAgent(issueBody, reviewBody, defaultAgent),
        context: {
          engine: 'kiro',
          repoFullName,
          executionContext: `task-${jobId}`,
        },
      })

      if (!result.success) {
        log.error({ exitCode: result.exitCode }, 'Kiro CLI failed for changes requested')
        await postPRFeedbackError(
          octokit,
          repoFullName,
          prNumber,
          result.stderr || 'Kiro CLI failed',
        )
        return
      }

      // Verify Kiro CLI pushed commits to the remote branch
      const pushed = await prManager.verifyPushedCommits({
        repoFullName,
        branchName,
        workingDir,
      })

      if (!pushed) {
        log.warn('Kiro CLI completed but no pushed commits detected for changes requested')
      }

      log.info({ pushed }, 'Kiro CLI completed for changes requested')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error({ error: message }, 'Failed to handle changes requested')
      await postPRFeedbackError(octokit, repoFullName, prNumber, message)
    } finally {
      if (workingDir) {
        await repoCloner.cleanup(workingDir)
      }
    }
  }

  // ── handlePRComment ─────────────────────────────────────────────

  /**
   * Handles a general comment on a Worker-created PR (delivered as
   * an `issue_comment` event by GitHub).
   *
   * Clones the repo (setup script runs automatically during clone),
   * checks out the PR branch, constructs a prompt with the comment
   * body, and invokes the Kiro CLI. The Kiro CLI handles committing,
   * pushing, and posting a reply comment on the PR. After completion,
   * verifies pushed commits via PR_Manager.verifyPushedCommits.
   */
  const handlePRComment = async (params: HandlePRCommentParams): Promise<void> => {
    const {
      octokit,
      token,
      repoFullName,
      prNumber,
      issueNumber,
      commentBody,
      commentAuthor,
      branchName,
      issueTitle,
      issueBody,
      botUsername,
      jobId,
    } = params

    const log = logger.child({
      repo: repoFullName,
      prNumber,
      issueNumber,
      step: 'pr-comment',
    })

    // Loop prevention: ignore bot's own comments
    if (isBotComment(commentBody, commentAuthor, botUsername)) {
      log.debug('Ignoring bot-authored PR comment')
      return
    }

    let workingDir: string | undefined

    try {
      // Clone and checkout the PR branch
      const cloneResult = await repoCloner.cloneForFollowUp(
        repoFullName,
        issueNumber ?? prNumber,
        branchName,
        token,
        octokit,
      )
      workingDir = cloneResult.workingDir

      // Write session log for rocky.sh output so it appears in admin dashboard
      if (cloneResult.setupScriptResult != null) {
        void sessionLogWriter.writeSessionLog(
          {
            success: cloneResult.setupScriptResult.exitCode === 0,
            hasChanges: false,
            stdout: cloneResult.setupScriptResult.stdout,
            stderr: cloneResult.setupScriptResult.stderr,
            exitCode: cloneResult.setupScriptResult.exitCode,
          },
          {
            engine: 'kiro',
            repoFullName,
            executionContext: `setup-task-${jobId}`,
          },
        )
      }

      const prompt = buildPRReviewPrompt(
        issueTitle,
        issueBody,
        commentBody,
        repoFullName,
        issueNumber ?? 0,
        prNumber,
      )

      log.info('Invoking Kiro CLI for PR comment')
      const result = await executorRouter.execute(workingDir, prompt, {
        agent: resolveWebhookAgent(issueBody, commentBody, defaultAgent),
        context: {
          engine: 'kiro',
          repoFullName,
          executionContext: `task-${jobId}`,
        },
      })

      if (!result.success) {
        log.error({ exitCode: result.exitCode }, 'Kiro CLI failed for PR comment')
        await postPRFeedbackError(
          octokit,
          repoFullName,
          prNumber,
          result.stderr || 'Kiro CLI failed',
        )
        return
      }

      // Verify Kiro CLI pushed commits to the remote branch
      const pushed = await prManager.verifyPushedCommits({
        repoFullName,
        branchName,
        workingDir,
      })

      if (!pushed) {
        log.warn('Kiro CLI completed but no pushed commits detected for PR comment')
      }

      log.info({ pushed }, 'Kiro CLI completed for PR comment')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error({ error: message }, 'Failed to handle PR comment')
      await postPRFeedbackError(octokit, repoFullName, prNumber, message)
    } finally {
      if (workingDir) {
        await repoCloner.cleanup(workingDir)
      }
    }
  }

  return { handleReviewComment, handleChangesRequested, handlePRComment }
}
