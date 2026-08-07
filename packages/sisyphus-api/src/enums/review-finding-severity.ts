import { createEnumGuard } from './enum-guard'

/**
 * How serious one review finding is, most serious first.
 *
 * The order is the vocabulary: it is what lets a panel sort findings and a reader skim them, so it
 * is declared here rather than reconstructed by a comparator at each call site.
 */
export const REVIEW_FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'info'] as const

export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number]

export const isReviewFindingSeverity = createEnumGuard(REVIEW_FINDING_SEVERITIES)
