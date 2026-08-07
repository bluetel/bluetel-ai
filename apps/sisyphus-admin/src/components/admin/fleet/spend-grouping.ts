import type { RouterInputs } from '@sisyphus-admin/trpc'

/**
 * How the fleet view groups spend, and why one grouping is missing (FR-156).
 *
 * ## The default is not per-individual, and neither is anything else this view offers
 *
 * FR-156 records spend per workflow and keeps it fully attributable, but says the panel's
 * **default** aggregation must be by client, workspace or execution profile rather than by
 * individual — and that per-user totals, where they are shown at all, are for that user and for
 * admins, and are never a ranked comparison between people.
 *
 * The procedure accepts `user` as a grouping because that per-user total has to be reachable
 * somewhere. This screen is not that somewhere: it is the fleet oversight view, its rows are
 * ordered by spend descending, and a list of colleagues ordered by spend descending is exactly the
 * league table FR-156 rules out. So `user` is absent from {@link FLEET_SPEND_GROUPINGS}.
 *
 * ## The absence is enforced, not documented
 *
 * The grouping travels in the query string, so "the toggles do not offer it" would be a rule a
 * hand-edited URL walks straight past. {@link parseSpendGrouping} is therefore total and closed: it
 * maps anything that is not one of the three collective groupings — `user` included, and named in
 * the test for that reason — back to {@link DEFAULT_FLEET_GROUPING}. There is no path through this
 * module that produces `user`, which is why the panel below it needs no check of its own.
 */

/** The groupings `workflow.spendSummary` accepts, inferred rather than restated. */
export type SpendGrouping = NonNullable<RouterInputs['workflow']['spendSummary']['groupBy']>

/**
 * The groupings this screen offers: a client, a workspace, a profile — never a person.
 *
 * `client` is the originating integration, which is the platform's one per-customer boundary; a
 * manually started run belongs to no client and is reported as such rather than being attributed to
 * one the panel invented.
 */
export const FLEET_SPEND_GROUPINGS = [
  'client',
  'workspace',
  'profile',
] as const satisfies readonly SpendGrouping[]

export type FleetSpendGrouping = (typeof FLEET_SPEND_GROUPINGS)[number]

/** What the view groups by when the URL says nothing — and what an unusable value falls back to. */
export const DEFAULT_FLEET_GROUPING: FleetSpendGrouping = 'profile'

/** The query-string key the grouping travels under. Short, because operators paste these URLs. */
export const GROUPING_PARAM = 'by'

/** What each grouping is called on screen. Sentence case: a toggle is a thing a person does. */
export const GROUPING_LABELS = {
  client: 'Client',
  workspace: 'Workspace',
  profile: 'Execution profile',
} as const satisfies Record<FleetSpendGrouping, string>

/** Whether a value is one of the groupings this screen is willing to show. */
export const isFleetGrouping = (value: unknown): value is FleetSpendGrouping =>
  FLEET_SPEND_GROUPINGS.some((grouping) => grouping === value)

/**
 * Read a grouping out of a search param.
 *
 * Total, and closed over {@link FLEET_SPEND_GROUPINGS}: `user`, a typo and a stale link all land on
 * {@link DEFAULT_FLEET_GROUPING}. A URL cannot turn this screen into a per-person breakdown.
 *
 * @param value - The raw search-param value, which may repeat or be absent.
 */
export const parseSpendGrouping = (
  value: string | readonly string[] | undefined,
): FleetSpendGrouping => {
  const first = value === undefined ? undefined : typeof value === 'string' ? value : value[0]
  return isFleetGrouping(first) ? first : DEFAULT_FLEET_GROUPING
}

/**
 * Turn a grouping into the procedure's input.
 *
 * Typed as the procedure's own input so a grouping this module invented could not be sent.
 */
export const toSpendSummaryInput = (
  grouping: FleetSpendGrouping,
): RouterInputs['workflow']['spendSummary'] => ({ groupBy: grouping })
