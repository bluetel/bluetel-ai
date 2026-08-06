import { describe, expect, it } from 'vitest'

import {
  CONCURRENCY_CEILING_VARIABLE,
  DEFAULT_CONCURRENCY_CEILING,
  readConcurrencyCeiling,
} from './concurrency-ceiling'

describe('the concurrency ceiling', () => {
  it('reads a configured value', () => {
    expect(readConcurrencyCeiling({ [CONCURRENCY_CEILING_VARIABLE]: '12' })).toBe(12)
  })

  it('falls back to the default when unset or blank', () => {
    expect(readConcurrencyCeiling({})).toBe(DEFAULT_CONCURRENCY_CEILING)
    expect(readConcurrencyCeiling({ [CONCURRENCY_CEILING_VARIABLE]: '   ' })).toBe(
      DEFAULT_CONCURRENCY_CEILING,
    )
  })

  it('refuses a value that is present but unusable, naming the variable', () => {
    for (const raw of ['0', '-1', '2.5', 'lots', '1e3']) {
      expect(() => readConcurrencyCeiling({ [CONCURRENCY_CEILING_VARIABLE]: raw })).toThrow(
        CONCURRENCY_CEILING_VARIABLE,
      )
    }
  })

  it('keeps the default small enough that a platform nobody configured queues rather than spends', () => {
    expect(DEFAULT_CONCURRENCY_CEILING).toBeLessThanOrEqual(10)
    expect(DEFAULT_CONCURRENCY_CEILING).toBeGreaterThan(0)
  })
})
