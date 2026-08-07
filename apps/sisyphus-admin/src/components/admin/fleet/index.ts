/**
 * Fleet oversight and attributable spend (T135, FR-012, FR-013, FR-041, FR-156, FR-190).
 *
 * The page imports {@link FleetPanel} and {@link parseSpendGrouping} and nothing else; the rest is
 * exported for the colocated tests. Consumers import this barrel, never a module inside it.
 *
 * Nothing here is a primitive — the panel has exactly one primitive set, in `src/components/ui` —
 * and nothing here re-implements the fleet list. The filter bar, the list, the row shaping and the
 * filter serialisation come from `components/workflows`, because a second definition of FR-013's
 * filter set would be a second query string to keep in step. What this directory owns is the spend
 * view: how a grouping travels in a URL, how a scoped summary reads, and why the grouping that
 * names individuals is not on offer here (FR-156).
 */

export { FleetPanel } from './fleet-panel'

export {
  DEFAULT_FLEET_GROUPING,
  FLEET_SPEND_GROUPINGS,
  GROUPING_LABELS,
  GROUPING_PARAM,
  isFleetGrouping,
  parseSpendGrouping,
  toSpendSummaryInput,
} from './spend-grouping'
export type { FleetSpendGrouping, SpendGrouping } from './spend-grouping'

export { toSpendGroupReadouts, toSpendReadouts, UNATTRIBUTED } from './spend-readouts'
export type { SpendGroup, SpendGroupReadouts, SpendReadouts, SpendSummary } from './spend-readouts'

export { SpendSummaryCard } from './spend-summary-card'
