/**
 * The turn that asks for a development pass (T194).
 *
 * Three things go to the agent and nothing else: the skill, verbatim; the findings the previous
 * pass has to address, verbatim; and how to report the answer back.
 *
 * ## Why the skill is quoted rather than summarised
 *
 * `runDevelopStep` is explicit that the executor composes no instruction of its own about how to
 * branch, what to base on, or what a pull request should say (FR-057). This module is where that
 * would be violated if it were going to be, so it is written to make the violation obvious: the
 * only text it contributes is about the *report format*, and it contains no branch, no base, no
 * remote, no title, no ticket state and no rule for deriving any of them. Everything with an
 * opinion in it is inside the quoted skill body, which arrived from the client's repository with a
 * content digest attached.
 *
 * The distinction to hold on to is that naming a field is not stating a convention. Asking the
 * agent for `baseBranch` says nothing about what the base should be; it says the executor will not
 * proceed until the skill has been read well enough to answer. That is `requireDeliveryConventions`
 * expressed as a question rather than as a halt.
 *
 * ## Why the report format is stated every pass
 *
 * The markers carry a nonce and the nonce changes per request, so the instruction cannot be hoisted
 * out and sent once. That is the point: the autonomous loop sends three of these into one
 * conversation, and pass three must not be able to satisfy itself with pass one's answer.
 */

import type { DevelopmentRequest } from '../workflows'

import { SUMMARY_LISTS } from './development-proposal'
import { proposalMarkers } from './proposal-block'

/** Delimits the quoted skill, so its text is never confused with the executor's own. */
const skillFence = (name: string): { readonly open: string; readonly close: string } => ({
  open: `<<<skill:${name}`,
  close: `skill:${name}>>>`,
})

/** One finding, as the agent is shown it. Every part is the reviewer's; none is composed here. */
export const renderFinding = (finding: DevelopmentRequest['feedback'][number]): string => {
  const location = [finding.filePath, finding.line === undefined ? undefined : String(finding.line)]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(':')

  const anchor = [finding.workflowEntryId, location === '' ? undefined : location]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' ')

  return `- [${finding.severity}]${anchor === '' ? '' : ` ${anchor}`} ${finding.summary}`
}

/**
 * What the previous pass has to answer for, or a plain statement that there was no previous pass.
 *
 * Stated rather than omitted, for the same reason the reviewer summary renders an empty section:
 * an agent that is shown nothing cannot tell "no feedback" from "the feedback did not reach you".
 */
export const renderFeedback = (feedback: DevelopmentRequest['feedback']): string =>
  feedback.length === 0
    ? 'No earlier pass has been reviewed, so there are no findings to address.'
    : [
        'A previous pass was reviewed and failed. Every finding below must be addressed by this ' +
          'pass; they are the reviewer’s words, not the platform’s.',
        '',
        ...feedback.map(renderFinding),
      ].join('\n')

/**
 * The reporting contract, in the agent's own reply.
 *
 * Everything asked for here is a field of `DevelopmentProposal`, and every one of them is read
 * back by `readDevelopmentProposal` with no default behind it. The wording says so, because an
 * agent that believes a missing field will be filled in for it has been given a reason to leave
 * one out.
 */
export const renderReportInstruction = (nonce: string): string => {
  const { open, close } = proposalMarkers(nonce)

  return [
    'When the work of this pass is finished, report it by emitting exactly one block in this ' +
      'form, as ordinary assistant output:',
    '',
    open,
    '{ ... a single JSON object ... }',
    close,
    '',
    'The JSON object carries these keys:',
    '',
    '- `conventions`: an object holding `remote`, `branchName`, `baseBranch`, `pullRequestTitle` ' +
      'and optionally `bodyPreamble`, each of them read out of the skill above. Nothing supplies ' +
      'these if you do not: a value you leave out is not filled in, and the run stops naming the ' +
      'skill instead.',
    '- `summary`: an object for the engineer who has to review work they did not write. It holds ' +
      '`entries` — one per workspace entry you touched or deliberately did not, each with ' +
      '`repository`, `changed` (true or false), `description`, and optionally `entryId`, ' +
      `\`subdirectory\` and \`paths\` — and the four lists ${SUMMARY_LISTS.map((key) => `\`${key}\``).join(', ')}. ` +
      'All four are required and each may be empty; an empty list means you had none, while a ' +
      'missing list means you did not answer, and those are not the same thing.',
    '- `ticketInstruction` and `ticketState`: what the skill says to do with the ticket, in the ' +
      'skill’s own words, and the state it named. Omit both if the skill says nothing about the ' +
      'ticket; the ticket is then left alone.',
    '- `wasChanged`: false if this pass produced no change at all, which is a legitimate outcome.',
    '',
    'Report only what you actually did. If you could not determine something the skill was ' +
      'supposed to tell you, leave the field out and say so in the summary — an invented value ' +
      'is acted on as though it were the skill’s.',
  ].join('\n')
}

export interface DevelopTurnOptions {
  readonly request: DevelopmentRequest
  /** Ties the reply to this request; see `proposal-block.ts`. */
  readonly nonce: string
}

/**
 * Compose the turn body for one development pass.
 *
 * @param options - The request as `runDevelopStep` built it, and this request's nonce.
 * @returns The text written to the live conversation as one user turn.
 */
export const developTurnBody = (options: DevelopTurnOptions): string => {
  const { request, nonce } = options
  const fence = skillFence(request.skill.skillName)

  return [
    `Development pass ${String(request.ordinal)}.`,
    '',
    `The ${request.skill.skillName} skill below was read from ${request.skill.resolvedPath} in ` +
      `the primary repository (sha256 ${request.skill.contentDigest}). It is the instruction for ` +
      'this pass. Follow it as written; the platform adds nothing to it.',
    '',
    fence.open,
    request.skill.body,
    fence.close,
    '',
    renderFeedback(request.feedback),
    '',
    renderReportInstruction(nonce),
  ].join('\n')
}
