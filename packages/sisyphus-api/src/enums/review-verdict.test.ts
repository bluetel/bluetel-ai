import { describe, expect, it } from 'vitest'

import { isReviewVerdict, REVIEW_VERDICTS } from './review-verdict'

describe('REVIEW_VERDICTS', () => {
  it('offers exactly two verdicts, so an iteration always counts against the FR-061 bound', () => {
    expect([...REVIEW_VERDICTS]).toStrictEqual(['pass', 'fail'])
  })

  it('guards membership', () => {
    expect(isReviewVerdict('fail')).toBe(true)
    expect(isReviewVerdict('inconclusive')).toBe(false)
  })
})
