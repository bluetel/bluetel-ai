import { describe, expect, it } from 'vitest'

import { isValidationOutcome, VALIDATION_OUTCOMES } from './validation-outcome'

describe('VALIDATION_OUTCOMES', () => {
  it('records a proof as passed or failed and nothing in between (FR-148)', () => {
    expect([...VALIDATION_OUTCOMES]).toStrictEqual(['passed', 'failed'])
  })

  it('keeps the order the validation_outcome column was created with', () => {
    // A pgEnum generated from a reordered tuple is a migration rather than an edit, so the order
    // is pinned here as well as being described in the module note.
    expect(VALIDATION_OUTCOMES[0]).toBe('passed')
    expect(VALIDATION_OUTCOMES[1]).toBe('failed')
  })

  it('does not admit a per-phase outcome as a run outcome', () => {
    // `timed_out` is a `bootstrap_phase_outcome`. A validation abandoned at its budget is `failed`
    // with the phase that hung recorded against it; admitting it here would make the two
    // vocabularies interchangeable and the column ambiguous.
    expect(isValidationOutcome('timed_out')).toBe(false)
    expect(isValidationOutcome('succeeded')).toBe(false)
  })

  it('guards membership', () => {
    expect(isValidationOutcome('passed')).toBe(true)
    expect(isValidationOutcome('Passed')).toBe(false)
  })
})
