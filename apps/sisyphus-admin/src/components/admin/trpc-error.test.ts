import { describe, expect, it } from 'vitest'

import {
  describeTrpcError,
  isNotFoundError,
  MAPPED_TRPC_ERROR_CODES,
  readTrpcErrorCode,
  UNEXPECTED_ERROR,
} from './trpc-error'

/** The shape `@trpc/client` rejects with — the code lives under `data`, not on the error itself. */
const rejection = (code: string): unknown => ({ message: 'refused', data: { code } })

describe('readTrpcErrorCode', () => {
  it('reads the code off a tRPC client error', () => {
    expect(readTrpcErrorCode(rejection('FORBIDDEN'))).toBe('FORBIDDEN')
  })

  it.each([
    undefined,
    null,
    'FORBIDDEN',
    42,
    new Error('network down'),
    { data: null },
    { data: 7 },
  ])('answers undefined for %s rather than throwing a second time', (value) => {
    expect(readTrpcErrorCode(value)).toBeUndefined()
  })

  it('answers undefined when data carries no string code', () => {
    expect(readTrpcErrorCode({ data: { code: 500 } })).toBeUndefined()
  })
})

describe('isNotFoundError', () => {
  it('recognises the out-of-scope answer', () => {
    expect(isNotFoundError(rejection('NOT_FOUND'))).toBe(true)
  })

  it('does not treat a forbidden as a not-found, because they mean different things', () => {
    expect(isNotFoundError(rejection('FORBIDDEN'))).toBe(false)
  })

  it('does not treat a network failure as a not-found', () => {
    expect(isNotFoundError(new Error('fetch failed'))).toBe(false)
  })
})

describe('describeTrpcError', () => {
  it.each(MAPPED_TRPC_ERROR_CODES)('gives %s both a machine code and a next action', (code) => {
    const content = describeTrpcError(rejection(code))

    expect(content.code).toMatch(/^E_[A-Z_]+$/)
    expect(content.action.length).toBeGreaterThan(0)
  })

  it('falls back to the catch-all for a code it does not map', () => {
    expect(describeTrpcError(rejection('INTERNAL_SERVER_ERROR'))).toStrictEqual(UNEXPECTED_ERROR)
  })

  it('falls back to the catch-all when the rejection is not a tRPC error at all', () => {
    expect(describeTrpcError(new Error('fetch failed'))).toStrictEqual(UNEXPECTED_ERROR)
  })

  it('never produces a dead end, which is the whole reason both halves are required', () => {
    const contents = [...MAPPED_TRPC_ERROR_CODES, 'SOMETHING_ELSE'].map((code) =>
      describeTrpcError(rejection(code)),
    )

    expect(contents.every((content) => content.code !== '' && content.action !== '')).toBe(true)
    expect(contents.map((content) => content.action)).not.toContain('Something went wrong')
  })

  it('lets a screen that knows what a code means there supply its own', () => {
    const override = { code: 'E_LAST_ACTIVE_ADMIN', action: 'Promote someone else first.' }

    expect(
      describeTrpcError(rejection('PRECONDITION_FAILED'), { PRECONDITION_FAILED: override }),
    ).toStrictEqual(override)
  })

  it('leaves the other codes on their defaults when one is overridden', () => {
    const override = { code: 'E_LAST_ACTIVE_ADMIN', action: 'Promote someone else first.' }

    expect(describeTrpcError(rejection('FORBIDDEN'), { PRECONDITION_FAILED: override }).code).toBe(
      'E_ADMIN_REQUIRED',
    )
  })
})
