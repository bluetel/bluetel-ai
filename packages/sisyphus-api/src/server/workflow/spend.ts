import type { SpendSummaryInput } from '../../schemas'
import { spendSummaryInput } from '../../schemas'
import { scopedProcedure } from '../procedures'
import type { ScopedReadOptions } from '../scope'

import type { SpendGroup, SpendSummary } from './queries'
import { summariseSpend } from './queries'

/**
 * **Spend attribution (T132, FR-156, FR-190, SC-051).**
 *
 * ## This module deliberately issues no query of its own
 *
 * The scoped aggregate already exists: `./queries.ts` → `summariseSpend`, mounted as
 * `workflow.spendSummary`, composing the FR-190 base selector into the statement itself and folding
 * its overall figure out of the scoped groups so the total and its parts cannot disagree. A second
 * aggregate here — with its own joins, its own `where` and therefore its own opinion of what the
 * caller may see — is precisely the silent leak FR-190 is about, and it would be a leak that looked
 * like a number rather than like data.
 *
 * So everything below **composes** that one aggregate. The database work is entirely
 * `summariseSpend`'s; what this module adds is the part of FR-156 that is not a `select`.
 *
 * ## What FR-156 asks for beyond a scoped total
 *
 * Three sentences, and only the first is a query:
 *
 * 1. spend is recorded per workflow and stays fully attributable — `workflows.spend_used` for the
 *    model, `workflows.compute_cost_basis` for the instance (FR-041), both per run;
 * 2. the panel's **default** aggregation is by client, workspace or execution profile rather than
 *    by individual;
 * 3. per-user totals are visible **to that user and to admins**, and are never presented as a
 *    ranked comparison between individuals.
 *
 * (2) is enforced by the schema — `spendSummaryInput.groupBy` defaults to `profile` — and
 * {@link defaultSpendGrouping} reads that default off the schema rather than restating it, so the
 * assertion in `spend.test.ts` fails if the default is ever moved to `user`. A constant copied here
 * would have gone on passing.
 *
 * (3) is what {@link attributeSpend} exists for, and neither half of it is served by scoping alone:
 *
 * - **Scope is not privacy between individuals.** A caller granted a shared execution profile can
 *   see every run on it, including runs owned by colleagues — legitimately, under FR-183. Grouping
 *   those by owner would turn a cost view into a per-person breakdown of people the caller merely
 *   shares a profile with, which is the surveillance FR-156's second sentence forbids. So a
 *   non-admin's individual grouping is narrowed to their own row.
 * - **Order is presentation, and a ranking is an assertion.** `summariseSpend` orders by spend
 *   descending, which is right for clients and workspaces — the operational question is which of
 *   them costs the most. Applied to people the same ordering *is* the league table FR-156's third
 *   sentence rules out, so an individual grouping is re-ordered by label and says so through
 *   {@link AttributedSpend.ranked}.
 *
 * The totals are re-folded from the rows that survive, by the same rule `summariseSpend` uses, so
 * the invariant "the total is the sum of the groups shown" holds here too. A caller cannot subtract
 * their own row from a larger total and recover what everyone else spent.
 */

/** How spend may be grouped. Inferred from the schema, never restated. */
export type SpendGrouping = SpendSummaryInput['groupBy']

/**
 * The one grouping that names individuals.
 *
 * Named rather than compared inline, so the rule "individuals are treated differently" appears once
 * and every branch below reads as a consequence of it.
 */
export const INDIVIDUAL_SPEND_GROUPING = 'user' satisfies SpendGrouping

/**
 * The groupings that name a collective rather than a person — a client, a workspace, a profile.
 *
 * These are the ones FR-156 says the panel should default to, and the ones for which ordering by
 * spend is a legitimate operational answer rather than a comparison between colleagues.
 */
export const COLLECTIVE_SPEND_GROUPINGS = [
  'client',
  'workspace',
  'profile',
] as const satisfies readonly SpendGrouping[]

/** Whether this grouping puts individual people in the rows. */
export const isIndividualGrouping = (groupBy: SpendGrouping): boolean =>
  groupBy === INDIVIDUAL_SPEND_GROUPING

/**
 * The grouping a caller who asks for none receives.
 *
 * Read **off the schema** by parsing an empty input rather than by restating the literal, so this
 * cannot agree with the documentation while disagreeing with the procedure. `spend.test.ts` asserts
 * the result is a member of {@link COLLECTIVE_SPEND_GROUPINGS}, which is how FR-156's default is
 * enforced rather than merely described.
 */
export const defaultSpendGrouping = (): SpendGrouping => spendSummaryInput.parse({}).groupBy

/** A scoped spend summary with FR-156's presentation rules applied. */
export interface AttributedSpend extends SpendSummary {
  /** The grouping actually used, echoed so the panel labels the figure it is showing. */
  readonly groupBy: SpendGrouping
  /**
   * Whether the groups are ordered by spend. Always false for an individual grouping — a ranked
   * list of people is the comparison FR-156 forbids, and the panel must not re-sort into one.
   */
  readonly ranked: boolean
  /**
   * Whether the caller is seeing only their own row of an individual grouping. True for every
   * non-admin asking for the individual grouping, so the panel can say whose figure this is rather
   * than implying it is everybody's.
   */
  readonly ownRowOnly: boolean
}

/**
 * Order by label, then by id.
 *
 * Alphabetical rather than by spend, and deterministic rather than merely stable: two people with
 * the same display name must still come out in the same order on every request, or the "not a
 * ranking" claim would be true only on average.
 */
const byLabelThenId = (left: SpendGroup, right: SpendGroup): number => {
  const leftLabel = left.groupLabel ?? ''
  const rightLabel = right.groupLabel ?? ''
  if (leftLabel !== rightLabel) {
    return leftLabel < rightLabel ? -1 : 1
  }

  const leftId = left.groupId ?? ''
  const rightId = right.groupId ?? ''
  if (leftId === rightId) {
    return 0
  }
  return leftId < rightId ? -1 : 1
}

/**
 * Fold groups into the overall figure.
 *
 * The same rule `summariseSpend` folds by — sum the scoped groups rather than issue a second
 * total — so narrowing the rows narrows the total with them. A header total larger than the rows
 * beneath it would let a caller recover, by subtraction, exactly the per-individual figures the
 * narrowing removed.
 */
const foldGroups = (groups: readonly SpendGroup[]): SpendSummary => ({
  groups,
  workflowCount: groups.reduce((total, group) => total + group.workflowCount, 0),
  spendTotal: groups.reduce((total, group) => total + Number(group.spendTotal), 0).toFixed(4),
  turnsTotal: groups.reduce((total, group) => total + group.turnsTotal, 0),
})

/**
 * Grouped spend with FR-156's rules on individuals applied.
 *
 * Delegates the whole query — and therefore the whole of FR-190 — to `summariseSpend`. A caller
 * outside every profile sees an empty summary here for the same reason they see an empty list
 * there: the base selector matched nothing, not because anything in this module decided so.
 *
 * @param options - The handle, the resolved scope, and the validated input.
 * @returns The scoped summary, narrowed and re-ordered where the rows are people.
 */
export const attributeSpend = async (
  options: ScopedReadOptions & { readonly input: SpendSummaryInput },
): Promise<AttributedSpend> => {
  const summary = await summariseSpend(options)
  const { groupBy } = options.input

  if (!isIndividualGrouping(groupBy)) {
    return { ...summary, groupBy, ranked: true, ownRowOnly: false }
  }

  // Admins see every individual (FR-156 names them explicitly); everyone else sees the one row
  // FR-156 guarantees them — their own. `groupId` for this grouping is `workflows.owner_user_id`.
  const ownRowOnly = !options.scope.isAdmin
  const retained = ownRowOnly
    ? summary.groups.filter((group) => group.groupId === options.scope.userId)
    : [...summary.groups]

  return {
    ...foldGroups(retained.sort(byLabelThenId)),
    groupBy,
    ranked: false,
    ownRowOnly,
  }
}

/**
 * `workflow.spendAttribution` — the panel's spend read (FR-156, FR-190, SC-051).
 *
 * `scopedProcedure`, like every other read on the workflow router, and for the same reason: the
 * aggregate underneath it composes the FR-190 base selector, so a caller can no more discover a run
 * through a total than through a row.
 */
export const spendAttributionProcedure = scopedProcedure
  .input(spendSummaryInput)
  .query(
    async ({ ctx, input }): Promise<AttributedSpend> =>
      attributeSpend({ db: ctx.db, scope: ctx.scope, input }),
  )
