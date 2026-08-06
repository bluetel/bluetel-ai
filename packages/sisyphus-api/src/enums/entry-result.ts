import { createEnumGuard } from './enum-guard'

/**
 * Per-entry result of a multi-repo run (FR-114, FR-118).
 *
 * `unchanged` is a success, not a nothing: a repository the run correctly decided needed no edit
 * must be distinguishable from one it never reached. Recorded per entry because staleness and
 * success are both evaluated per repository, never for the run as a whole (FR-115).
 */
export const ENTRY_RESULTS = ['unchanged', 'landed', 'failed'] as const

export type EntryResult = (typeof ENTRY_RESULTS)[number]

export const isEntryResult = createEnumGuard(ENTRY_RESULTS)
