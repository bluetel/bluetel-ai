import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * Shaping `workflow.spendSummary` into what the fleet's spend card renders (FR-156, FR-190).
 *
 * The type comes from `RouterOutputs`, never from a hand-written DTO: a mirrored interface drifts
 * silently, because nothing fails when the procedure adds a field and the copy does not.
 *
 * ## Money is passed through, never reformatted
 *
 * `spendTotal` is a `numeric(12,4)` carried as a decimal string precisely so it is never rounded in
 * transit. Applying a currency format here would be the panel deciding what the platform's money
 * looks like — a decision that belongs in a token, not in a readout — and it would round a figure
 * the database went to some trouble not to round. So the string arrives and the string is shown.
 *
 * ## The share is for the meter, and it is a share of what is visible
 *
 * `share` is the group's spend as a percentage of the summary's own total. That total is the scoped
 * one: `workflow.spendSummary` folds it from the groups it is allowed to return, so a group's share
 * is its share of what the caller may see, not of what the platform spent. Anything else would need
 * an unscoped denominator, which is the FR-190 leak wearing a percentage sign.
 */

/** The summary as `workflow.spendSummary` returns it. */
export type SpendSummary = RouterOutputs['workflow']['spendSummary']

/** One group of it. */
export type SpendGroup = SpendSummary['groups'][number]

/**
 * What a group with no key reads as.
 *
 * A run started by hand has no originating integration, and a run started ad hoc has no execution
 * profile — both are facts about how the run began (FR-126), so the row says so rather than showing
 * a blank cell that looks like missing data.
 */
export const UNATTRIBUTED = 'unattributed'

/** What one row of the spend card shows. Every value is a string, because every value is a readout. */
export interface SpendGroupReadouts {
  /** Stable key for the row. The group id, or {@link UNATTRIBUTED} when there is none. */
  readonly key: string
  readonly name: string
  readonly workflows: string
  /** The decimal string as the procedure returned it. Never rounded here. */
  readonly spend: string
  readonly turns: string
  /** Share of the scoped total, 0–100, for the meter. */
  readonly share: number
}

/** What the card's header and totals show. */
export interface SpendReadouts {
  readonly groups: readonly SpendGroupReadouts[]
  readonly workflows: string
  readonly spend: string
  readonly turns: string
}

/**
 * Derive one group's readouts.
 *
 * @param group - The group as the procedure returned it.
 * @param total - The summary's scoped total, as the denominator for the share.
 */
export const toSpendGroupReadouts = (group: SpendGroup, total: string): SpendGroupReadouts => {
  const totalSpend = Number(total)
  const groupSpend = Number(group.spendTotal)

  return {
    key: group.groupId ?? UNATTRIBUTED,
    name: group.groupLabel ?? UNATTRIBUTED,
    workflows: String(group.workflowCount),
    spend: group.spendTotal,
    turns: String(group.turnsTotal),
    // A zero total means every group is zero, so a zero share is the honest reading rather than a
    // division that would be `NaN`.
    share: totalSpend > 0 ? (groupSpend / totalSpend) * 100 : 0,
  }
}

/**
 * Derive the whole card's readouts.
 *
 * The group order is the procedure's — spend descending — and is deliberately not re-sorted here.
 * For the collective groupings this screen offers, "which of these costs the most" is the question.
 *
 * @param summary - As `workflow.spendSummary` returned it.
 */
export const toSpendReadouts = (summary: SpendSummary): SpendReadouts => ({
  groups: summary.groups.map((group) => toSpendGroupReadouts(group, summary.spendTotal)),
  workflows: String(summary.workflowCount),
  spend: summary.spendTotal,
  turns: String(summary.turnsTotal),
})
