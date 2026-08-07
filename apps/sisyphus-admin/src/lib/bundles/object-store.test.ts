import { describe, expect, it } from 'vitest'

import { codedError, isCodedError, OBJECT_ALREADY_EXISTS, OBJECT_NOT_FOUND } from './object-store'

describe('codedError', () => {
  it('is a real Error, so a stack survives and a thrown value is catchable as one', () => {
    const error = codedError(OBJECT_NOT_FOUND, 'Nothing there.')

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('Nothing there.')
  })

  it('carries a machine code the panel can show alongside a next action (FR-031)', () => {
    expect(codedError(OBJECT_ALREADY_EXISTS, 'Taken.').code).toBe(OBJECT_ALREADY_EXISTS)
  })
})

describe('isCodedError', () => {
  it('matches on the code rather than on the class', () => {
    // `instanceof` across a bundler boundary is the check that quietly stops working, which is why
    // the codes exist at all.
    expect(isCodedError(codedError(OBJECT_NOT_FOUND, 'x'), OBJECT_NOT_FOUND)).toBe(true)
    expect(isCodedError(codedError(OBJECT_NOT_FOUND, 'x'), OBJECT_ALREADY_EXISTS)).toBe(false)
  })

  it('is false for a plain error and for a non-error', () => {
    expect(isCodedError(new Error('plain'), OBJECT_NOT_FOUND)).toBe(false)
    expect(isCodedError('not an error', OBJECT_NOT_FOUND)).toBe(false)
    expect(isCodedError(undefined, OBJECT_NOT_FOUND)).toBe(false)
  })
})
