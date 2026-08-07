import { describe, expect, it } from 'vitest'

import { isReviewFindingSeverity, REVIEW_FINDING_SEVERITIES } from './review-finding-severity'

describe('REVIEW_FINDING_SEVERITIES', () => {
  it('is ordered most serious first, which is what a reader and a sort both rely on', () => {
    expect([...REVIEW_FINDING_SEVERITIES]).toStrictEqual(['blocker', 'major', 'minor', 'info'])
    expect(REVIEW_FINDING_SEVERITIES[0]).toBe('blocker')
    expect(REVIEW_FINDING_SEVERITIES.at(-1)).toBe('info')
  })

  it('guards membership', () => {
    expect(isReviewFindingSeverity('blocker')).toBe(true)
    expect(isReviewFindingSeverity('critical')).toBe(false)
  })
})
