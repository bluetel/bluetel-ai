/**
 * The autonomous loop's iteration record (T127, FR-061, FR-062, FR-119).
 *
 * Nothing here is a primitive and nothing here duplicates `WorkflowTimeline`, which lists lifecycle
 * transitions. What lives here is the question that timeline cannot answer because it is about the
 * work rather than about the machine: three attempts at the same change, what each review said, and
 * — the part a reader actually arrives for — what is still wrong.
 *
 * Two things the barrel is holding in place:
 *
 * - **It exports nothing that would act on a run.** A fourth iteration is refused by the
 *   `iterations_ordinal_bounds` check constraint, so a retry control here would be a button that
 *   cannot work (FR-061).
 * - **The bound is shown, never enforced here.** `MAX_ITERATIONS` is what makes an ordinal render
 *   as `2 of 3`; it is a label, and the database is the authority.
 *
 * Consumers import this barrel, never a module inside it.
 */

export { IterationTimelineCard } from './iteration-timeline-card'

export { toIterationRecords } from './iteration-source'
export type { IterationPass } from './iteration-source'

export {
  MAX_ITERATIONS,
  toIterationTimelineReadouts,
  unresolvedFindings,
} from './iteration-readouts'
export type {
  FindingReadouts,
  IterationReadouts,
  IterationRecord,
  IterationTimelineReadouts,
  IterationVerdict,
} from './iteration-readouts'
