/* cspell:words issuetype */
import type { CandidateItem, DiscoverySkip, ItemComment } from '@bluetel-ai/sisyphus-api/contracts'

import type { JiraCommentRecord, JiraIssue } from './client'
import type { PlatformIdentity } from './is-platform-authored'
import { isPlatformAuthored } from './is-platform-authored'

/**
 * Turning one Jira issue into a candidate — or declining to, and saying why.
 *
 * ## The two kinds of "bad ticket", which are not the same kind
 *
 * A ticket with an empty summary and no description is **not** malformed. It is a real ticket
 * somebody labelled without describing, and FR-164 has a specific answer for it: the control plane
 * skips it, records the reason, and *comments on it* so the person who labelled it finds out. That
 * answer needs a candidate to act on — the key to claim, the URL to comment on — so an empty
 * ticket becomes a candidate with an empty title and a null body, and the decision stays with the
 * control plane where the requirement puts it.
 *
 * A ticket with no key is different: there is nothing to claim (FR-102 makes the key the claim
 * key), nothing to comment on, and no URL to put in a prompt. It cannot be acted on at all, so it
 * is declined — and declined *loudly*, via {@link DiscoverySkip}, because the one thing worse than
 * an unusable ticket is an unusable ticket nobody hears about (FR-105).
 *
 * ## What the skip detail may contain
 *
 * The issue id, and nothing else. Not the summary, not the description. An integration run record
 * is read by anyone who can see the integration, and FR-072 does not carve out an exception for
 * diagnostics.
 */

export type CandidateResult =
  | { readonly ok: true; readonly item: CandidateItem }
  | { readonly ok: false; readonly skip: DiscoverySkip }

/** Reason code for an issue that cannot be represented at all. */
export const UNUSABLE_ISSUE = 'unusable_item'

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')

const blankToNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null
  }
  return value.trim().length === 0 ? null : value
}

/**
 * Who a comment is by, for the record.
 *
 * Account id first because it is stable and not personal data; the email address only where there
 * is no account id, and the display name last. Never blank: an unattributable comment is recorded
 * as unattributable rather than silently attributed to nobody.
 */
const authorIdentityOf = (author: JiraCommentRecord['author']): string =>
  author?.accountId ?? author?.emailAddress ?? author?.displayName ?? 'unknown'

const toItemComment = (
  comment: JiraCommentRecord,
  index: number,
  platform: PlatformIdentity,
): ItemComment => ({
  id: comment.id.length > 0 ? comment.id : `index-${String(index)}`,
  authorIdentity: authorIdentityOf(comment.author),
  isPlatformAuthored: isPlatformAuthored(comment.author ?? {}, platform),
  body: comment.body ?? '',
  createdAt: new Date(comment.created ?? 0),
})

const isValidDate = (date: Date): boolean => !Number.isNaN(date.getTime())

/**
 * Chronological, which FR-159 requires and Jira usually already provides.
 *
 * Sorted only when every timestamp parsed. A partial sort against invalid dates would reorder
 * comments by an accident of parsing, and Jira's own order is a better guess than that.
 */
const inChronologicalOrder = (comments: readonly ItemComment[]): readonly ItemComment[] => {
  if (!comments.every((comment) => isValidDate(comment.createdAt))) {
    return comments
  }

  return [...comments].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
}

/**
 * The mapping criteria a rule may test (FR-130).
 *
 * Named as Jira names them, so an admin writing a criterion uses the word they see in the issue
 * view and in JQL. `components` and `labels` stay as lists rather than being joined: a rule asking
 * for the `api` component means "is one of the components", and flattening would turn that into a
 * string-parsing problem.
 */
const attributesOf = (issue: JiraIssue): Readonly<Record<string, string | readonly string[]>> => {
  const fields = issue.fields ?? {}
  const components = (fields.components ?? [])
    .map((component) => component.name)
    .filter((name): name is string => name !== undefined)

  return {
    ...(fields.project?.key ? { project: fields.project.key } : {}),
    ...(fields.issuetype?.name ? { issuetype: fields.issuetype.name } : {}),
    ...(fields.status?.name ? { status: fields.status.name } : {}),
    ...(components.length > 0 ? { components } : {}),
    ...(fields.labels && fields.labels.length > 0 ? { labels: [...fields.labels] } : {}),
  }
}

/**
 * @param issue - One issue from a search page.
 * @param context - The board's base URL and the identity whose comments are the platform's own.
 * @returns The candidate, or the skip to record.
 */
export const toCandidateItem = (
  issue: JiraIssue,
  context: { readonly baseUrl: string; readonly platform: PlatformIdentity },
): CandidateResult => {
  const key = issue.key

  if (key === undefined || key.length === 0) {
    return {
      ok: false,
      skip: {
        reason: UNUSABLE_ISSUE,
        detail: `Jira returned an issue with no key (id ${issue.id ?? 'unknown'}); it cannot be claimed or commented on.`,
      },
    }
  }

  const fields = issue.fields ?? {}
  const comments = inChronologicalOrder(
    (fields.comment?.comments ?? []).map((comment, index) =>
      toItemComment(comment, index, context.platform),
    ),
  )

  return {
    ok: true,
    item: {
      externalId: key,
      title: fields.summary ?? '',
      url: `${trimTrailingSlash(context.baseUrl)}/browse/${key}`,
      body: blankToNull(fields.description),
      assigneeEmail: fields.assignee?.emailAddress ?? null,
      comments,
      attributes: attributesOf(issue),
    },
  }
}
