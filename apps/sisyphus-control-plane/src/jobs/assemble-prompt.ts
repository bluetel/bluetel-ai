import type { PromptParts } from '@bluetel-ai/sisyphus-api/contracts'

import type { CommentBound, PromptRedactor, RedactedPromptParts } from './prompt-redact'
import { redactPromptParts } from './prompt-redact'

/**
 * Layered prompt assembly (T115, FR-157..FR-165).
 *
 * ## The layers, and why each belongs to somebody different
 *
 * 1. **The execution profile's preamble** — standing context about the *codebase*: where a contract
 *    lives, which conventions the repositories follow (FR-157). Optional, and prepended to every
 *    run on that profile whether a person or an integration started it.
 * 2. **The integration's intro** — standing context about the *board*: how work arriving from here
 *    should be approached (FR-158). Required, which is why an integration cannot be enabled without
 *    one. For a manually-started run the engineer's own prompt occupies this layer instead (FR-165),
 *    which is why {@link assemblePrompt} takes it as `intro` rather than as `integrationIntro`.
 * 3. **The ticket** — the actual task: title, URL, description, then comments oldest first
 *    (FR-159).
 *
 * Nobody has to restate what another layer already says, which is the whole point of the split. It
 * only works if the order is fixed and the boundaries are visible, so the order is a constant here
 * and every layer is delimited by a heading the agent can see (FR-159's "each part MUST be
 * delimited so the agent can tell the standing context apart from the ticket content").
 *
 * ## Why this lives in the control plane rather than in the executor
 *
 * The prompt has to exist **before** the workflow row: `workflows.assembled_prompt` is not
 * nullable-by-convenience, it is the record of what the agent was actually asked (FR-162), and the
 * row is written in the same transaction as the ticket claim (FR-102). An executor assembling its
 * own prompt would be assembling it after the row it is supposed to be recorded on, from a ticket
 * that has since changed — and FR-162 exists precisely because tickets change.
 *
 * It also could not be trusted to: prompt assembly reads the ticket, and reading the ticket needs
 * the board credential, which never reaches an instance.
 *
 * ## "As sent"
 *
 * {@link assembleIntegrationPrompt} returns the exact string that goes into the envelope and into
 * `workflows.assembled_prompt`. There is no second rendering path and no template applied later; a
 * record that was re-derived from the ticket at read time would be a description of the ticket
 * *now*, which is the thing FR-162 says the record must not depend on.
 */

/** The heading each layer opens with. Stable across runs — FR-159 fixes the order and the shape. */
export const PROMPT_SECTIONS = {
  preamble: 'WORKSPACE CONTEXT',
  intro: 'HOW WORK FROM THIS BOARD SHOULD BE APPROACHED',
  task: 'TASK',
  title: 'Ticket',
  url: 'Ticket URL',
  body: 'Description',
  comments: 'Ticket comments, oldest first',
} as const

/** Marks a comment the bound dropped, so the agent knows the history is partial (FR-163). */
export const TRUNCATION_NOTICE = (dropped: number): string =>
  `[${String(dropped)} older comment${dropped === 1 ? '' : 's'} omitted to fit the prompt bound]`

/** Said in place of a description when the ticket has none. Never a silent blank. */
export const NO_DESCRIPTION = '(the ticket has no description)'

export interface AssemblePromptInput {
  /** The execution profile's preamble (FR-157). Absent or blank means the layer is omitted. */
  readonly preamble?: string | null
  /**
   * The integration's prompt intro, or — for a manually-started run — the engineer's own prompt
   * (FR-158, FR-165). Required: a run started from an empty intro is a run nobody described.
   */
  readonly intro: string
  /** The ticket layers, already redacted and bounded. Absent for a manually-started run. */
  readonly ticket?: RedactedPromptParts
}

const isPresent = (value: string | null | undefined): value is string =>
  value !== undefined && value !== null && value.trim().length > 0

const section = (heading: string, body: string): string => `## ${heading}\n\n${body.trim()}`

/**
 * Render the layers, in the order FR-159 fixes.
 *
 * @param input - See {@link AssemblePromptInput}.
 * @returns The prompt as it will be sent and as it will be stored.
 * @throws If `intro` is blank. An integration cannot be enabled without a prompt intro and a manual
 *   launch cannot be made without a prompt, so a blank one here means a caller has lost it between
 *   the row and this function — which would silently produce a run with no task in it.
 */
export const assemblePrompt = (input: AssemblePromptInput): string => {
  if (!isPresent(input.intro)) {
    throw new Error(
      "A prompt cannot be assembled without its middle layer: an integration must carry a prompt intro (FR-158) and a manual launch must carry the engineer's prompt (FR-165). Assembling without it would start a run nobody described.",
    )
  }

  const layers: string[] = []

  if (isPresent(input.preamble)) {
    layers.push(section(PROMPT_SECTIONS.preamble, input.preamble))
  }

  layers.push(section(PROMPT_SECTIONS.intro, input.intro))

  const { ticket } = input

  if (ticket !== undefined) {
    const task = [
      `### ${PROMPT_SECTIONS.title}\n\n${ticket.title.trim()}`,
      `### ${PROMPT_SECTIONS.url}\n\n${ticket.url.trim()}`,
      `### ${PROMPT_SECTIONS.body}\n\n${isPresent(ticket.body) ? ticket.body.trim() : NO_DESCRIPTION}`,
    ]

    if (ticket.comments.length > 0 || ticket.truncatedComments > 0) {
      const comments: string[] = []

      if (ticket.truncatedComments > 0) {
        comments.push(TRUNCATION_NOTICE(ticket.truncatedComments))
      }

      for (const comment of ticket.comments) {
        comments.push(comment.trim())
      }

      task.push(`### ${PROMPT_SECTIONS.comments}\n\n${comments.join('\n\n---\n\n')}`)
    }

    layers.push(section(PROMPT_SECTIONS.task, task.join('\n\n')))
  }

  return `${layers.join('\n\n')}\n`
}

export interface AssembleIntegrationPromptOptions extends CommentBound {
  /** The profile's preamble (FR-157). */
  readonly preamble?: string | null
  /** The integration's prompt intro (FR-158). */
  readonly intro: string
  /** What the connector produced from the ticket. */
  readonly parts: PromptParts
  /** The run-output redaction standard, injected — see `prompt-redact.ts`. */
  readonly redactor: PromptRedactor
}

/** The prompt as sent, with what the record has to say about what it left out. */
export interface AssembledPrompt {
  /** Goes into the envelope and into `workflows.assembled_prompt` verbatim (FR-162). */
  readonly prompt: string
  /** Sets `workflows.prompt_truncated` (FR-163). */
  readonly truncated: boolean
  /** How many comments were dropped, across the connector's bound and the storage bound. */
  readonly truncatedComments: number
}

/**
 * Redact, bound, then assemble — in that order, because the bound is on what is stored.
 *
 * The order matters more than it looks. Assembling first and redacting the whole string would work
 * for the pattern stage and fail the bound: the budget would have been spent on text that
 * redaction then replaced with placeholders, so a ticket with several credentials in it would store
 * fewer comments than one without, for no reason a reader could see.
 *
 * @param options - See {@link AssembleIntegrationPromptOptions}.
 */
export const assembleIntegrationPrompt = (
  options: AssembleIntegrationPromptOptions,
): AssembledPrompt => {
  const ticket = redactPromptParts(options.parts, {
    redactor: options.redactor,
    ...(options.maxCharacters === undefined ? {} : { maxCharacters: options.maxCharacters }),
    ...(options.maxComments === undefined ? {} : { maxComments: options.maxComments }),
  })

  return {
    prompt: assemblePrompt({
      ...(options.preamble === undefined ? {} : { preamble: options.preamble }),
      intro: options.intro,
      ticket,
    }),
    truncated: ticket.truncatedComments > 0,
    truncatedComments: ticket.truncatedComments,
  }
}

/**
 * Whether a ticket carries a task at all (FR-164).
 *
 * A ticket whose title *and* description are both empty is skipped with the reason recorded and
 * communicated on the ticket, rather than started with a prompt carrying no task. Comments are
 * deliberately not counted: a ticket that is only a comment thread has no statement of what is
 * wanted, and starting a paid run on one is how a board's chatter becomes a bill.
 */
export const hasNoTask = (parts: Pick<PromptParts, 'title' | 'body'>): boolean =>
  !isPresent(parts.title) && !isPresent(parts.body)
