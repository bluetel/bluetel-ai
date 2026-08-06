import { createEnumGuard } from './enum-guard'

/**
 * The outcome of one review iteration.
 *
 * Two values and no third: a review that could not reach a verdict is a failed iteration with a
 * recorded reason, not a separate `inconclusive` state that nothing downstream would know how to
 * count against the FR-061 iteration bound.
 */
export const REVIEW_VERDICTS = ['pass', 'fail'] as const

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]

export const isReviewVerdict = createEnumGuard(REVIEW_VERDICTS)
