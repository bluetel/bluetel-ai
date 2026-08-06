import type {
  CandidateItem,
  ExternalActionResult,
  WriteBackEvent,
} from '@bluetel-ai/sisyphus-api/contracts'

import type { JiraRestClient } from './client'
import { commentKey, hasMarker, renderCommentBody } from './comment-body'
import type { ResolvedJiraConfig } from './config'
import { isPlatformAuthored } from './is-platform-authored'
import type { PlatformIdentity } from './is-platform-authored'
import { resolvePlatformIdentity } from './platform-identity'

/**
 * Commenting on a ticket, at most once per thing there is to say (T113, FR-142..FR-144, FR-077).
 *
 * ## The failure
 *
 * A comment is posted on a customer's ticket. Jira accepts it, and the connection dies before the
 * response arrives. From here that is indistinguishable from a request Jira never saw, and FR-047
 * says retry — so the customer is looking at two identical comments from an automated system on
 * their ticket. Then three.
 *
 * There is no way to make "post a comment" atomic across a network, so this does not try. It makes
 * the *identity* of the comment something both sides can agree on (`./comment-body`, built with
 * the platform's shared `externalActionKey`), and then follows the same order the executor's
 * delivery path follows:
 *
 * 1. **Look before creating.** A comment already carrying this key's marker, written by the
 *    platform, means a previous attempt landed. A lookup that *fails* is not a lookup that found
 *    nothing — it propagates, and nothing is posted. Treating "could not ask" as "not there" is
 *    precisely how the second comment gets posted.
 * 2. **Post**, handing Jira the derived key for the deployments that honour one.
 * 3. **Look again if it threw.** The timeout case: the request may have been accepted and the
 *    response lost, so before the error is allowed out, Jira is asked. If the comment is there,
 *    this attempt *succeeded* — the caller's retry loop never runs, and no second comment appears.
 *
 * ## Both halves of "is this mine"
 *
 * A previous attempt is recognised by the marker **and** by the author being the platform.
 * Requiring authorship as well is not belt-and-braces: the marker is text in a comment body, so a
 * person can paste one. A marker-only test would let anybody suppress the pickup comment on a
 * ticket by quoting an old one — and quoting an old one is a normal thing to do.
 */

/** How far back through a ticket's comments a lookup will page before giving up. */
const MAX_COMMENT_PAGES = 20

const findPreviousComment = async (
  client: JiraRestClient,
  config: ResolvedJiraConfig,
  issueKey: string,
  key: string,
  platform: PlatformIdentity,
): Promise<string | undefined> => {
  let startAt = 0

  for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
    const result = await client.listComments({
      issueKey,
      startAt,
      maxResults: config.pageSize,
    })

    if (result.comments.length === 0) {
      return undefined
    }

    const match = result.comments.find(
      (comment) =>
        hasMarker(comment.body, key) && isPlatformAuthored(comment.author ?? {}, platform),
    )

    if (match) {
      return match.id
    }

    startAt += result.comments.length

    if (result.total !== undefined && startAt >= result.total) {
      return undefined
    }

    if (result.comments.length < config.pageSize) {
      return undefined
    }
  }

  return undefined
}

/**
 * @param client - The Jira seam.
 * @param config - The board configuration.
 * @param item - The ticket to comment on.
 * @param event - What to say.
 * @returns The action's key, whether this call posted it, and the comment's id.
 * @throws Whatever posting threw, but only once Jira has been asked and does not have the comment.
 */
export const writeBack = async (
  client: JiraRestClient,
  config: ResolvedJiraConfig,
  item: CandidateItem,
  event: WriteBackEvent,
): Promise<ExternalActionResult> => {
  const platform = await resolvePlatformIdentity(config, client)
  const key = commentKey(item, event)

  const existing = await findPreviousComment(client, config, item.externalId, key, platform)

  if (existing !== undefined) {
    return { key, disposition: 'already-performed', reference: existing }
  }

  try {
    const posted = await client.addComment({
      issueKey: item.externalId,
      body: renderCommentBody(event, key),
      idempotencyKey: key,
    })

    return { key, disposition: 'performed', reference: posted.id }
  } catch (error) {
    const landed = await findPreviousComment(client, config, item.externalId, key, platform).catch(
      () => undefined,
    )

    if (landed !== undefined) {
      return { key, disposition: 'already-performed', reference: landed }
    }

    throw error
  }
}
