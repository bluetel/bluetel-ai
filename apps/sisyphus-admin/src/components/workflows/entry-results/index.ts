/**
 * What a multi-repository run actually achieved (T108, FR-114, FR-116, FR-118).
 *
 * Nothing here is a primitive and nothing here duplicates `WorkflowEntriesCard`, which enumerates
 * the workspace one repository at a time. What lives here is the question that card cannot answer
 * because it is about the set rather than any row: whether a run that reports itself finished
 * actually finished everywhere, and — where it did not — saying so in words rather than leaving a
 * reader to add up three cards.
 *
 * Consumers import this barrel, never a module inside it.
 */

export { toEntryResultsReadouts } from './entry-result-readouts'
export type {
  EntryOutcomeReadouts,
  EntryResultsReadouts,
  EntryStanding,
  EntryStandingCounts,
} from './entry-result-readouts'

export { EntryResultsCard } from './entry-results-card'
