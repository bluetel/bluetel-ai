import {
  type CandidateItem,
  type ExternalActionIdentity,
  externalActionKey,
  NO_WORKFLOW,
  type WriteBackEvent,
} from '@bluetel-ai/sisyphus-api/contracts'

/**
 * What Sisyphus says on a ticket, and how it recognises having said it.
 *
 * ## The identity is built with the shared builder, not with a scheme of its own
 *
 * `externalActionKey` is the platform's one way of naming an action against somebody else's
 * system; the executor's delivery path names pull requests with it and this names comments with
 * it. Its two rules are obeyed here rather than restated:
 *
 * - **What the comment is *for* is in the target.** A run comments on one ticket when it picks it
 *   up and again when it finishes; an identity built from the ticket alone would post the first
 *   and silently swallow the second as a replay.
 * - **The rendered text is not in the key.** Every body below varies — a workflow URL, a list of
 *   pull requests, a free-text detail — and a key that moved when the text moved would let a retry
 *   of a slightly-differently-rendered comment through as a new action. That is the duplicate
 *   comment on a customer's ticket the whole mechanism exists to prevent.
 *
 * A skip has no workflow, so it is keyed by {@link NO_WORKFLOW} and by its *reason*, which is a
 * closed vocabulary rather than the free text. One skip of a given kind is one comment, however
 * many ticks re-observe it — and a ticket later skipped for a different reason gets to say so.
 *
 * ## The marker is for finding, not for deciding authorship
 *
 * The marker is how a previous comment is recognised before posting another. It is deliberately
 * **not** how {@link import('./is-platform-authored').isPlatformAuthored} decides what to exclude
 * from a prompt: anyone can paste a marker into a comment, so authorship is decided by identity.
 * `./write-back` requires both — the marker *and* the platform's own authorship — before treating
 * a comment as a previous attempt, so a pasted marker cannot suppress a real write-back either.
 */

/** The action name for a ticket comment. */
export const JIRA_COMMENT_ACTION = 'jira-comment'

/** How readable the skip reasons are on the ticket, per FR-143. */
const SKIP_SENTENCES = {
  no_mapping_matched:
    'no execution profile mapping matched this ticket, so it was not started under a guessed one',
  ceiling_reached:
    'the integration reached its limit on how many runs it may start, so this ticket was deferred',
  integration_disabled: 'the integration is disabled',
  empty_item: 'the ticket has neither a summary nor a description, so there is no task to act on',
} as const

/**
 * The identity of one comment.
 *
 * @param item - The ticket it goes on.
 * @param event - What is being said.
 */
export const commentIdentity = (
  item: CandidateItem,
  event: WriteBackEvent,
): ExternalActionIdentity =>
  event.kind === 'skipped'
    ? {
        action: JIRA_COMMENT_ACTION,
        workflowId: NO_WORKFLOW,
        target: [item.externalId, event.kind, event.reason],
      }
    : {
        action: JIRA_COMMENT_ACTION,
        workflowId: event.workflowId,
        target: [item.externalId, event.kind],
      }

/** The derived key for one comment. Identical on every attempt of the same comment. */
export const commentKey = (item: CandidateItem, event: WriteBackEvent): string =>
  externalActionKey(commentIdentity(item, event))

/** The trailing marker that lets a previous attempt be recognised. */
export const renderMarker = (key: string): string => `[sisyphus:${key}]`

/**
 * Whether a comment body carries the marker for this key.
 *
 * On its own this proves nothing about who wrote it — see the note above.
 */
export const hasMarker = (body: string | undefined, key: string): boolean =>
  (body ?? '').includes(renderMarker(key))

const outcomeLines = (event: Extract<WriteBackEvent, { kind: 'outcome' }>): readonly string[] => {
  if (event.pullRequestUrls.length === 0) {
    return [`Sisyphus finished this ticket: ${event.outcome}.`, '', 'No pull request was opened.']
  }

  return [
    `Sisyphus finished this ticket: ${event.outcome}.`,
    '',
    'Pull requests:',
    ...event.pullRequestUrls.map((url) => `- ${url}`),
  ]
}

const bodyLines = (event: WriteBackEvent): readonly string[] => {
  switch (event.kind) {
    case 'picked_up':
      return [
        'Sisyphus has picked this ticket up and started a run.',
        '',
        `Progress: ${event.workflowUrl}`,
      ]
    case 'skipped':
      return [
        `Sisyphus did not start a run for this ticket: ${SKIP_SENTENCES[event.reason]}.`,
        ...(event.detail === undefined ? [] : ['', event.detail]),
      ]
    case 'outcome':
      return outcomeLines(event)
  }
}

/**
 * The comment as it will be posted, marker included.
 *
 * @param event - What is being said.
 * @param key - The derived action key, which the marker carries.
 */
export const renderCommentBody = (event: WriteBackEvent, key: string): string =>
  [...bodyLines(event), '', renderMarker(key)].join('\n')
