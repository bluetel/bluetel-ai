/**
 * Reading a {@link DevelopmentProposal} out of what the agent actually wrote (T194).
 *
 * This is the half of the bridge that decides whether an answer is an answer. `proposal-block.ts`
 * has already found an intact JSON object; everything below is about the difference between a
 * field the agent stated and a field it did not.
 *
 * ## Nothing here has a default, and one absence is deliberately somebody else's to report
 *
 * A field the block does not carry is left off the proposal. It is never filled in, never inferred
 * from another field, and never given a plausible value — a proposal assembled here that named a
 * branch nobody chose is the same defect as a hardcoded convention, arriving by a longer route
 * (FR-057).
 *
 * The delivery conventions are the sharpest case, and they are passed through **incomplete on
 * purpose**. `requireDeliveryConventions` already halts on a missing remote, branch, base or
 * title, and its halt names `sisyphus-dev` and the step, which is what FR-058 asks for and is more
 * use to an operator than anything this module could say about a JSON key. So a block that states
 * two conventions out of four produces a proposal with two conventions, and the workflow stops
 * where it was always going to stop.
 *
 * The reviewer summary is the opposite case and is refused here. `ReviewerSummaryInput` has no
 * partial form, `buildReviewerSummary` renders an absent section as "None recorded", and a
 * reviewer must be able to tell "it had no reservations" from "it did not answer" (FR-153). An
 * empty array is therefore the agent saying *none*, a missing key is the agent saying *nothing*,
 * and only the first is accepted. That is why the four judgement lists must be present even when
 * they are empty.
 *
 * ## A block that says nothing is its own outcome
 *
 * `{}` parses, is well-formed, and is not a proposal. It is reported as `empty` rather than as a
 * list of missing keys, because the two mean different things: one agent tried and left gaps, the
 * other never answered the question.
 */

import type { DevelopmentProposal } from '../workflows'

/**
 * The proposal's own field types, derived rather than imported.
 *
 * Everything this module produces is defined by `DevelopmentProposal`, so it takes its shapes from
 * there instead of reaching independently into `../delivery` and `../report`. One import, and no
 * way for this file to drift from the type it has to satisfy.
 */
type ProposedConventions = DevelopmentProposal['conventions']
type ProposedSummary = DevelopmentProposal['summary']
type ProposedEntry = ProposedSummary['entries'][number]

/** What the block turned out to be. */
export type ProposalReading =
  /** Everything needed is present. Conventions may still be partial; see the note above. */
  | { readonly kind: 'read'; readonly proposal: DevelopmentProposal }
  /** Well-formed and carrying none of the fields a proposal is made of. */
  | { readonly kind: 'empty' }
  /** Some of it is there. Every gap is named. */
  | { readonly kind: 'incomplete'; readonly problems: readonly string[] }

/** The keys a proposal can carry. A block with none of them has answered nothing. */
export const PROPOSAL_KEYS = [
  'conventions',
  'summary',
  'ticketInstruction',
  'ticketState',
  'wasChanged',
] as const

/** The four judgement lists, each required and each allowed to be empty (FR-153). */
export const SUMMARY_LISTS = ['decisions', 'assumptions', 'notDone', 'uncertainties'] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readText = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key]

  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

interface TextListReading {
  readonly items?: readonly string[]
  readonly problem?: string
}

/**
 * Read a list the agent must have stated, present or empty.
 *
 * A missing key and a list containing something that is not text are both reported. The second is
 * not pedantry: a number where a sentence should be is a section the reviewer will read as
 * complete and the agent never wrote.
 */
const readTextList = (
  source: Record<string, unknown>,
  key: string,
  where: string,
): TextListReading => {
  const value = source[key]

  if (value === undefined) {
    return {
      problem: `${where} does not state ${key}; an empty list is how a pass says there were none`,
    }
  }

  if (!Array.isArray(value)) {
    return { problem: `${where} states ${key} as something other than a list` }
  }

  if (value.some((item) => typeof item !== 'string')) {
    return { problem: `${where} states ${key} with an item that is not text` }
  }

  return { items: value.map((item) => String(item).trim()).filter((item) => item !== '') }
}

/**
 * Read whichever conventions the block stated, and only those.
 *
 * Written out one key at a time rather than looped, so that adding a convention is a visible edit
 * here and the set this bridge can carry is readable in one glance.
 */
const readConventions = (value: unknown, problems: string[]): ProposedConventions => {
  if (value === undefined) {
    return {}
  }

  if (!isRecord(value)) {
    problems.push('conventions is present but is not an object of named conventions')

    return {}
  }

  const remote = readText(value, 'remote')
  const branchName = readText(value, 'branchName')
  const baseBranch = readText(value, 'baseBranch')
  const pullRequestTitle = readText(value, 'pullRequestTitle')
  const bodyPreamble = readText(value, 'bodyPreamble')

  return {
    ...(remote === undefined ? {} : { remote }),
    ...(branchName === undefined ? {} : { branchName }),
    ...(baseBranch === undefined ? {} : { baseBranch }),
    ...(pullRequestTitle === undefined ? {} : { pullRequestTitle }),
    ...(bodyPreamble === undefined ? {} : { bodyPreamble }),
  }
}

const readEntry = (
  value: unknown,
  index: number,
  problems: string[],
): ProposedEntry | undefined => {
  const where = `summary entry ${String(index)}`

  if (!isRecord(value)) {
    problems.push(`${where} is not an object`)

    return undefined
  }

  const repository = readText(value, 'repository')
  const description = readText(value, 'description')
  const changed = value['changed']

  if (repository === undefined) {
    problems.push(`${where} does not name its repository`)
  }

  if (description === undefined) {
    problems.push(`${where} does not describe what changed, or why nothing did`)
  }

  // No default. `changed: true` invented here is a claim that work exists, made by the one
  // component in the chain that has not looked at the working tree.
  if (typeof changed !== 'boolean') {
    problems.push(`${where} does not say whether it was changed`)
  }

  if (repository === undefined || description === undefined || typeof changed !== 'boolean') {
    return undefined
  }

  const paths = readTextList(value, 'paths', where)
  const entryId = readText(value, 'entryId')
  const subdirectory = readText(value, 'subdirectory')

  return {
    repository,
    description,
    changed,
    ...(entryId === undefined ? {} : { entryId }),
    ...(subdirectory === undefined ? {} : { subdirectory }),
    // Optional, so an absent list is an absent list rather than a problem.
    ...(paths.items === undefined || paths.items.length === 0 ? {} : { paths: paths.items }),
  }
}

const readSummary = (value: unknown, problems: string[]): ProposedSummary | undefined => {
  if (value === undefined) {
    problems.push(
      'no summary for the reviewer, so nobody can be told what changed, what was decided, ' +
        'what was left alone or where the pass was unsure (FR-153)',
    )

    return undefined
  }

  if (!isRecord(value)) {
    problems.push('summary is present but is not an object')

    return undefined
  }

  const rawEntries = value['entries']

  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    problems.push('the summary describes no workspace entry')
  }

  const entries = (Array.isArray(rawEntries) ? rawEntries : []).map((entry, index) =>
    readEntry(entry, index, problems),
  )

  const decisions = readTextList(value, 'decisions', 'the summary')
  const assumptions = readTextList(value, 'assumptions', 'the summary')
  const notDone = readTextList(value, 'notDone', 'the summary')
  const uncertainties = readTextList(value, 'uncertainties', 'the summary')

  for (const reading of [decisions, assumptions, notDone, uncertainties]) {
    if (reading.problem !== undefined) {
      problems.push(reading.problem)
    }
  }

  const readEntries = entries.filter((entry): entry is ProposedEntry => entry !== undefined)

  if (
    readEntries.length === 0 ||
    readEntries.length !== entries.length ||
    decisions.items === undefined ||
    assumptions.items === undefined ||
    notDone.items === undefined ||
    uncertainties.items === undefined
  ) {
    return undefined
  }

  return {
    entries: readEntries,
    decisions: decisions.items,
    assumptions: assumptions.items,
    notDone: notDone.items,
    uncertainties: uncertainties.items,
  }
}

/**
 * Turn a block's JSON object into a proposal, or say why it is not one.
 *
 * @param value - The object `extractProposal` found. Trusted to be an object and nothing else.
 * @returns The proposal, the fact that the block said nothing, or every gap in it.
 */
export const readDevelopmentProposal = (value: Record<string, unknown>): ProposalReading => {
  if (!PROPOSAL_KEYS.some((key) => value[key] !== undefined)) {
    return { kind: 'empty' }
  }

  const problems: string[] = []
  const conventions = readConventions(value['conventions'], problems)
  const summary = readSummary(value['summary'], problems)
  const wasChanged = value['wasChanged']

  if (wasChanged !== undefined && typeof wasChanged !== 'boolean') {
    problems.push('wasChanged is present but is not true or false')
  }

  if (problems.length > 0 || summary === undefined) {
    return { kind: 'incomplete', problems }
  }

  const ticketInstruction = readText(value, 'ticketInstruction')
  const ticketState = readText(value, 'ticketState')

  return {
    kind: 'read',
    proposal: {
      conventions,
      summary,
      ...(ticketInstruction === undefined ? {} : { ticketInstruction }),
      ...(ticketState === undefined ? {} : { ticketState }),
      // Left off when the agent did not say. `runDevelopStep` reads an absent `wasChanged` as a
      // change having happened, and that decision stays where it is documented.
      ...(typeof wasChanged === 'boolean' ? { wasChanged } : {}),
    },
  }
}
