/**
 * Reading a {@link DeclaredIntegrationPlan} out of what the agent wrote (T196, FR-117, FR-118).
 *
 * The same discipline as `development-proposal.ts`: a key the block does not carry is left off, and
 * nothing here supplies an order, a step or a name. `promotion-order.ts` argues at length why every
 * plausible default order is wrong for somebody — primary-first, declaration order, alphabetical —
 * and the cost of guessing is a consumer promoted before the API it depends on, in a client's
 * estate, by a process nobody is watching.
 *
 * So an absent `order` is passed through absent, and `requirePromotionOrder` halts on it naming the
 * skill and the step. What this module *does* refuse is an order that is present and not a list of
 * entry ids, and a step that is present and missing a field — because both would otherwise reach
 * `requirePromotionOrder` and `runIntegrationStep` as something they would have to describe in
 * terms of JSON rather than in terms of the skill.
 *
 * ## An empty step list is an answer
 *
 * `statementFor` in `integration-step.ts` says "prescribes no integration steps for this run, so
 * none were taken", and reaches `succeeded`. That is a legitimate outcome — plenty of clients merge
 * by hand — so an empty list is read as an empty list, and only a *missing* key is read as the
 * agent not having answered.
 */

import type { DeclaredIntegrationPlan, DeclaredIntegrationStep } from '../workflows'

/** The keys a plan block can carry. A block with none of them has answered nothing. */
export const PLAN_KEYS = ['order', 'steps'] as const

/** What the block turned out to be. */
export type IntegrationPlanReading =
  | { readonly kind: 'read'; readonly plan: DeclaredIntegrationPlan }
  /** Well-formed and carrying neither an order nor a step list. */
  | { readonly kind: 'empty' }
  /** Something is there and cannot be used. Every problem is named. */
  | { readonly kind: 'unusable'; readonly problems: readonly string[] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readText = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key]

  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Read the declared order, or say why it is not one.
 *
 * Returns the `Partial<DeclaredPromotionOrder>` the plan type carries — `{}` when the object is
 * there and states no `entryIds`, so `requirePromotionOrder` reports "the skill declared no order"
 * rather than this module reporting a missing key. The two failures read identically to a machine
 * and very differently to a person, and the skill's name belongs in the one they see.
 */
const readOrder = (value: unknown, problems: string[]): DeclaredIntegrationPlan['order'] => {
  if (value === undefined) {
    return undefined
  }

  if (!isRecord(value)) {
    problems.push('order is present but is not an object carrying entryIds')

    return undefined
  }

  const entryIds = value['entryIds']

  if (entryIds === undefined) {
    return {}
  }

  if (!Array.isArray(entryIds) || entryIds.some((entryId) => typeof entryId !== 'string')) {
    problems.push('order.entryIds is present and is not a list of workspace entry ids')

    return undefined
  }

  return { entryIds: entryIds.map((entryId) => String(entryId).trim()) }
}

const readStep = (
  value: unknown,
  index: number,
  problems: string[],
): DeclaredIntegrationStep | undefined => {
  const where = `integration step ${String(index)}`

  if (!isRecord(value)) {
    problems.push(`${where} is not an object`)

    return undefined
  }

  const entryId = readText(value, 'entryId')
  const name = readText(value, 'name')
  const instruction = readText(value, 'instruction')

  if (entryId === undefined) {
    problems.push(`${where} does not name the workspace entry it applies to`)
  }

  if (name === undefined) {
    problems.push(`${where} has no name, so nothing can identify it in the run's record`)
  }

  if (instruction === undefined) {
    // No default, and the reason is the whole of FR-057: the instruction is the skill's words, and
    // an action performed against a blank one would be an action Sisyphus chose.
    problems.push(`${where} says nothing about what to do, in the skill's words or otherwise`)
  }

  return entryId === undefined || name === undefined || instruction === undefined
    ? undefined
    : { entryId, name, instruction }
}

const readSteps = (
  value: unknown,
  problems: string[],
): readonly DeclaredIntegrationStep[] | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    problems.push('steps is present but is not a list')

    return undefined
  }

  const read = value.map((step, index) => readStep(step, index, problems))

  return read.every((step): step is DeclaredIntegrationStep => step !== undefined)
    ? read
    : undefined
}

/**
 * Turn a block's JSON object into an integration plan, or say why it is not one.
 *
 * @param value - The object `extractBlock` found. Trusted to be an object and nothing else.
 * @returns The plan, the fact that the block said nothing, or every problem in it.
 */
export const readIntegrationPlan = (value: Record<string, unknown>): IntegrationPlanReading => {
  if (!PLAN_KEYS.some((key) => value[key] !== undefined)) {
    return { kind: 'empty' }
  }

  const problems: string[] = []
  const order = readOrder(value['order'], problems)
  const steps = readSteps(value['steps'], problems)

  if (problems.length > 0) {
    return { kind: 'unusable', problems }
  }

  return {
    kind: 'read',
    plan: {
      ...(order === undefined ? {} : { order }),
      ...(steps === undefined ? {} : { steps }),
    },
  }
}
