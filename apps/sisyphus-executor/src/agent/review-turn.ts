/**
 * The turn that asks for a review (T196, FR-057, FR-058, FR-063, FR-119).
 *
 * The same shape as `develop-turn.ts` and for the same reasons. Two things go to the agent and
 * nothing else: `sisyphus-review`, verbatim; and every pull request under review, as a set. The
 * only text composed here is about the *report format*.
 *
 * ## The rubric is not here, and neither is a severity ladder
 *
 * `review-step.ts` is explicit that what counts as a blocker is the client's business and is stated
 * in `sisyphus-review`. So this file names no category of defect, no threshold, and no rule for
 * choosing between one severity and another — it names the four severities the *platform* can
 * record, which is a fact about the database and not an opinion about code. The distinction is the
 * same one `develop-turn.ts` draws about asking for `baseBranch`: naming a field is not stating a
 * convention.
 *
 * ## The set is shown whole, always
 *
 * Every target in one turn, even when there is one of them (FR-119). The interesting defects in a
 * cross-repository change live between the repositories, and a reviewer shown one at a time cannot
 * see them — `review-set.ts` argues this at length. Presenting a single-entry run identically is
 * what keeps the multi-entry case off a code path nobody exercises.
 *
 * ## Findings are asked for anchored, because a single verdict is otherwise unreadable
 *
 * One verdict covers the whole set, so the only thing that tells a reader which repository a
 * blocker is in is the finding's own anchor. `workflowEntryId` is asked for by entry id rather than
 * by repository name for the same reason `review-set.ts` groups by it: the entry id is what the
 * platform records a finding against, and a name would have to be matched back to one.
 */

import { REVIEW_FINDING_SEVERITIES } from '@bluetel-ai/sisyphus-api/client'

import type { ReviewRequest, ReviewTarget } from '../workflows'

import { answerMarkers } from './proposal-block'

/** Names the review block for a human reading the log, and keeps it distinct from a proposal. */
export const REVIEW_TAG = 'sisyphus-review-verdict'

/** Delimits the quoted skill, so its text is never confused with the executor's own. */
const skillFence = (name: string): { readonly open: string; readonly close: string } => ({
  open: `<<<skill:${name}`,
  close: `skill:${name}>>>`,
})

/** One pull request, as the agent is shown it. Entry id included, because findings anchor to it. */
export const renderTarget = (target: ReviewTarget): string =>
  `- ${target.repository} #${String(target.pullRequestNumber)} (${target.pullRequestUrl}) — ` +
  `workspace entry ${target.entryId}`

/**
 * Every pull request under review, stated as a set.
 *
 * The count is spelled out because "review these" reads differently from "review these two
 * together", and the second is what FR-119 asks for.
 */
export const renderTargets = (targets: readonly ReviewTarget[]): string =>
  [
    targets.length === 1
      ? 'One pull request is under review:'
      : `${String(targets.length)} pull requests are under review and are one change. Weigh them ` +
        'together and reach a single verdict over the set:',
    '',
    ...targets.map(renderTarget),
  ].join('\n')

/**
 * The reporting contract, in the agent's own reply.
 *
 * Every key here is a field of `ReviewProposal`, and every one is read back by
 * `readReviewProposal` with no default behind it. The wording says so, because an agent that
 * believes a missing field will be filled in for it has been given a reason to leave one out.
 */
export const renderReviewReportInstruction = (nonce: string): string => {
  const { open, close } = answerMarkers(REVIEW_TAG, nonce)

  return [
    'When the review is finished, report it by emitting exactly one block in this form, as ' +
      'ordinary assistant output:',
    '',
    open,
    '{ ... a single JSON object ... }',
    close,
    '',
    'The JSON object carries these keys:',
    '',
    '- `verdict`: `"pass"` or `"fail"`, decided by the rubric in the skill above and by nothing ' +
      'else. There is no third value: a review that omits this is treated as a review that never ' +
      'happened, and the run stops naming the skill rather than assuming either answer.',
    `- \`findings\`: a list, each with \`severity\` (one of ${REVIEW_FINDING_SEVERITIES.map((value) => `\`${value}\``).join(', ')}), ` +
      '`summary`, and — wherever you can place it — `workflowEntryId` (the workspace entry id from ' +
      'the list above), `filePath` and `line`. A failing verdict must name at least one finding: ' +
      'the next development pass is driven entirely by this list, so a failure that names nothing ' +
      'guarantees an identical failure next time. A severity outside that set is not recorded as ' +
      'something else — the run stops instead.',
    '- `comment`: the comment to post on the pull requests, composed by you as the skill ' +
      'prescribes. Omit it if the skill prescribes no comment; nothing is posted then.',
    '- `ticketInstruction` and `ticketState`: what the skill says to do with the ticket for this ' +
      'verdict, in the skill’s own words, and the state it named. Omit both if the skill says ' +
      'nothing about the ticket; the ticket is then deliberately left where it is.',
    '',
    'Report only what the skill supports. This run makes no code changes of any kind — there is ' +
      'no path through it that could — so a finding is the only way anything you notice reaches ' +
      'anybody.',
  ].join('\n')
}

export interface ReviewTurnOptions {
  readonly request: ReviewRequest
  /** Ties the reply to this request; see `proposal-block.ts`. */
  readonly nonce: string
}

/**
 * Compose the turn body for one review pass.
 *
 * @param options - The request as `runReviewStep` built it, and this request's nonce.
 * @returns The text written to the live conversation as one user turn.
 */
export const reviewTurnBody = (options: ReviewTurnOptions): string => {
  const { request, nonce } = options
  const fence = skillFence(request.skill.skillName)

  return [
    request.ordinal === undefined
      ? 'Review pass.'
      : `Review of development pass ${String(request.ordinal)}.`,
    '',
    `The ${request.skill.skillName} skill below was read from ${request.skill.resolvedPath} in ` +
      `the primary repository (sha256 ${request.skill.contentDigest}). It is the rubric for this ` +
      'review. Follow it as written; the platform adds nothing to it.',
    '',
    fence.open,
    request.skill.body,
    fence.close,
    '',
    renderTargets(request.targets),
    '',
    renderReviewReportInstruction(nonce),
  ].join('\n')
}
