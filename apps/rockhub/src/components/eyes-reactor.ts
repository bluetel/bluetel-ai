// Eyes_Reactor — GitHub reaction adder.
//
// Adds an `eyes` (👀) reaction to the source object identified by a
// TriggerMention. The reactor never throws — it catches all errors and
// returns `{ status: 'failed', reason }` with a warn log. Every log
// entry includes `mentionIdentity`, `repo`, `sourceType` structured fields.
//
// Endpoint mapping:
//   issue_comment | pr_comment       -> POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions
//   pr_review_comment                -> POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions
//   issue_body | pr_body | issue_assignment | pr_review_request
//                                    -> POST /repos/{owner}/{repo}/issues/{issue_or_pr_number}/reactions

import type { Octokit } from '@octokit/rest'
import type pino from 'pino'

import type { TriggerMention } from '../lib'

// -- Public Interfaces --

export interface EyesReactorDeps {
  octokit: Octokit
  logger: pino.Logger
}

export interface EyesReactorInstance {
  react: (mention: TriggerMention) => Promise<EyesReactorOutcome>
}

export type EyesReactorOutcome =
  | { status: 'reacted' }
  | { status: 'already_present' }
  | { status: 'failed'; reason: string }

// -- Factory --

export const createEyesReactor = (deps: EyesReactorDeps): EyesReactorInstance => {
  const { octokit, logger } = deps
  const log = logger.child({ component: 'eyes-reactor' })

  const callReactionEndpoint = async (mention: TriggerMention) => {
    const { owner, repo, sourceType, commentId, issueOrPrNumber } = mention

    switch (sourceType) {
      case 'issue_comment':
      case 'pr_comment':
        return octokit.request(
          'POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions',
          { owner, repo, comment_id: commentId as number, content: 'eyes' },
        )

      case 'pr_review_comment':
        return octokit.request('POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions', {
          owner,
          repo,
          comment_id: commentId as number,
          content: 'eyes',
        })

      case 'issue_body':
      case 'pr_body':
      case 'issue_assignment':
      case 'pr_review_request':
        return octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/reactions', {
          owner,
          repo,
          issue_number: issueOrPrNumber as number,
          content: 'eyes',
        })
    }
  }

  const react = async (mention: TriggerMention): Promise<EyesReactorOutcome> => {
    const logCtx = {
      mentionIdentity: mention.identity,
      repo: mention.repoFullName,
      sourceType: mention.sourceType,
    }

    try {
      const response = await callReactionEndpoint(mention)

      if (response.status === 201) {
        log.info(logCtx, 'eyes reaction created')
        return { status: 'reacted' }
      }

      // 200 means the reaction already existed (idempotent re-add)
      log.info(logCtx, 'eyes reaction already present')
      return { status: 'already_present' }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      log.warn({ ...logCtx, error: reason }, 'eyes reaction failed')
      return { status: 'failed', reason }
    }
  }

  return { react }
}
