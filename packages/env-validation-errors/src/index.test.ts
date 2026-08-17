import type { StandardSchemaV1 } from '@t3-oss/env-core'
import * as fc from 'fast-check'
import { describe, it, expect, vi, afterEach } from 'vitest'

import { formatEnvErrors, onValidationError } from './index'

// ---------------------------------------------------------------------------
// Shared generator: arrays of 1–10 ZodIssue-like objects with distinct paths
// ---------------------------------------------------------------------------

const zodIssueArb = fc
  .record({
    path: fc.stringMatching(/^[A-Z][A-Z0-9_]{0,19}$/).map((s) => [s]),
    message: fc.string({ minLength: 1, maxLength: 100 }),
  })
  .map(({ path, message }) => ({
    code: 'custom' as const,
    path,
    message,
  }))

/**
 * Generate arrays of 1–10 issues with distinct paths so every issue
 * maps to a unique env var name in the formatted output.
 */
const zodIssuesArb = fc
  .array(zodIssueArb, { minLength: 1, maxLength: 10 })
  .map((issues) => {
    const seen = new Set<string>()
    return issues.filter((issue) => {
      const key = issue.path[0]
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  })
  .filter((arr) => arr.length > 0)

// ---------------------------------------------------------------------------
// 4.1 — Property 1: Formatted message contains all issue details
// ---------------------------------------------------------------------------

describe('Feature: env-validation-errors, Property 1: Formatted message contains all issue details', () => {
  /**
   * **Validates: Requirements 2.1, 2.2, 2.3**
   *
   * For any non-empty array of Zod issues with distinct paths and messages,
   * the formatted error message must contain every issue's path and message.
   */
  it('formatted message contains every issue path and message', () => {
    fc.assert(
      fc.property(zodIssuesArb, (issues) => {
        const result = formatEnvErrors(issues)

        for (const issue of issues) {
          const envVarName = issue.path[0]
          expect(result).toContain(envVarName)
          expect(result).toContain(issue.message)
        }
      }),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// 4.2 — Property 2: Handler logs and throws with formatted message
// ---------------------------------------------------------------------------

describe('Feature: env-validation-errors, Property 2: Handler logs and throws with formatted message', () => {
  /**
   * **Validates: Requirements 3.2, 3.3**
   *
   * For any non-empty array of Zod issues, onValidationError must:
   * - call console.error with a string containing the formatted message
   * - throw an Error whose message equals formatEnvErrors(issues)
   */
  it('onValidationError logs to console.error and throws Error with formatted message', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      fc.assert(
        fc.property(zodIssuesArb, (issues) => {
          errorSpy.mockClear()
          const expected = formatEnvErrors(issues)

          let thrownError: Error | undefined
          try {
            onValidationError(issues)
          } catch (e) {
            thrownError = e as Error
          }

          // Must have called console.error with a string containing the formatted message
          expect(errorSpy).toHaveBeenCalledOnce()
          const loggedArg = String(errorSpy.mock.calls[0]?.[0])
          expect(loggedArg).toContain(expected)

          // Must throw an Error whose message equals the formatted message
          expect(thrownError).toBeInstanceOf(Error)
          expect(thrownError?.message).toBe(expected)
        }),
        { numRuns: 100 },
      )
    } finally {
      errorSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// 4.3 — Property 3: Formatting function consistency with handler
// ---------------------------------------------------------------------------

describe('Feature: env-validation-errors, Property 3: Formatting function consistency with handler', () => {
  /**
   * **Validates: Requirements 5.2**
   *
   * For any non-empty array of Zod issues, formatEnvErrors(issues) must equal
   * the message of the Error thrown by onValidationError(issues).
   */
  it('formatEnvErrors output equals the Error message from onValidationError', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      fc.assert(
        fc.property(zodIssuesArb, (issues) => {
          errorSpy.mockClear()
          const formatted = formatEnvErrors(issues)

          let thrownMessage: string | undefined
          try {
            onValidationError(issues)
          } catch (e) {
            thrownMessage = (e as Error).message
          }

          expect(formatted).toBe(thrownMessage)
        }),
        { numRuns: 100 },
      )
    } finally {
      errorSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// 4.4 — Property 4: Formatting function has no side effects
// ---------------------------------------------------------------------------

describe('Feature: env-validation-errors, Property 4: Formatting function has no side effects', () => {
  /**
   * **Validates: Requirements 5.3**
   *
   * For any non-empty array of Zod issues, formatEnvErrors must not throw
   * and must not call console.error.
   */
  it('formatEnvErrors does not throw and does not call console.error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      fc.assert(
        fc.property(zodIssuesArb, (issues) => {
          errorSpy.mockClear()

          expect(() => formatEnvErrors(issues)).not.toThrow()

          expect(errorSpy).not.toHaveBeenCalled()
        }),
        { numRuns: 100 },
      )
    } finally {
      errorSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// 4.5 — Property 5: skipValidation reflects environment variable
// ---------------------------------------------------------------------------

describe('Feature: env-validation-errors, Property 5: skipValidation reflects environment variable', () => {
  const originalSkipEnv = process.env.SKIP_ENV_VALIDATION

  afterEach(() => {
    vi.resetModules()
    if (originalSkipEnv === undefined) {
      delete process.env.SKIP_ENV_VALIDATION
    } else {
      process.env.SKIP_ENV_VALIDATION = originalSkipEnv
    }
  })

  /**
   * **Validates: Requirements 6.1, 6.4**
   *
   * For any string value assigned to SKIP_ENV_VALIDATION, the skipValidation
   * constant must equal true iff the value is exactly 'true'.
   */
  it('skipValidation is true iff SKIP_ENV_VALIDATION is exactly "true"', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 0, maxLength: 50 }), async (value) => {
        process.env.SKIP_ENV_VALIDATION = value
        vi.resetModules()

        const mod: { skipValidation: boolean } = await import('./index')

        if (value === 'true') {
          expect(mod.skipValidation).toBe(true)
        } else {
          expect(mod.skipValidation).toBe(false)
        }
      }),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// 4.6 — Property 6: createSafeEnv applies all baked-in defaults
// ---------------------------------------------------------------------------

describe('Feature: env-validation-errors, Property 6: createSafeEnv applies all baked-in defaults', () => {
  const originalSkipEnv = process.env.SKIP_ENV_VALIDATION

  afterEach(() => {
    vi.resetModules()
    if (originalSkipEnv === undefined) {
      delete process.env.SKIP_ENV_VALIDATION
    } else {
      process.env.SKIP_ENV_VALIDATION = originalSkipEnv
    }
  })

  /**
   * **Validates: Requirements 6.3, 7.2, 7.3, 7.4**
   *
   * For any valid schema config, createSafeEnv must pass
   * emptyStringAsUndefined: true, the onValidationError handler,
   * and skipValidation matching process.env.SKIP_ENV_VALIDATION === 'true'
   * to the underlying createEnv call.
   */
  it('createSafeEnv passes baked-in defaults to createEnv', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (shouldSkip) => {
        process.env.SKIP_ENV_VALIDATION = shouldSkip ? 'true' : 'false'
        vi.resetModules()

        // Use vi.doMock (not hoisted) to mock createEnv for this iteration
        const mockCreateEnv = vi.fn(() => ({}))

        vi.doMock('@t3-oss/env-core', async (importOriginal) => {
          const actual = (await importOriginal()) as Record<string, unknown>
          return { ...actual, createEnv: mockCreateEnv }
        })

        const mod: {
          createSafeEnv: (opts: Record<string, unknown>) => unknown
          onValidationError: (issues: readonly StandardSchemaV1.Issue[]) => never
        } = await import('./index')

        mod.createSafeEnv({ runtimeEnv: process.env })

        expect(mockCreateEnv).toHaveBeenCalledOnce()
        const callArgs = mockCreateEnv.mock.calls[0] as unknown[]
        const passedOpts = callArgs[0] as Record<string, unknown>

        expect(passedOpts.emptyStringAsUndefined).toBe(true)
        expect(passedOpts.onValidationError).toBe(mod.onValidationError)
        expect(passedOpts.skipValidation).toBe(shouldSkip)
      }),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// 4.7 — Unit tests for edge cases and type compatibility
// ---------------------------------------------------------------------------

describe('Unit tests: edge cases and type compatibility', () => {
  const originalSkipEnv = process.env.SKIP_ENV_VALIDATION

  afterEach(() => {
    vi.resetModules()
    if (originalSkipEnv === undefined) {
      delete process.env.SKIP_ENV_VALIDATION
    } else {
      process.env.SKIP_ENV_VALIDATION = originalSkipEnv
    }
  })

  /**
   * Test onValidationError console output starts with ❌
   * **Validates: Requirement 3.4**
   */
  it('onValidationError console output starts with ❌', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const issues: StandardSchemaV1.Issue[] = [{ message: 'Required', path: ['DATABASE_URL'] }]

    try {
      onValidationError(issues)
    } catch {
      // expected
    }

    expect(errorSpy).toHaveBeenCalledOnce()
    const loggedArg = String(errorSpy.mock.calls[0]?.[0])
    expect(loggedArg.startsWith('❌')).toBe(true)

    errorSpy.mockRestore()
  })

  /**
   * Test skipValidation is false when SKIP_ENV_VALIDATION is unset
   * **Validates: Requirement 6.4**
   */
  it('skipValidation is false when SKIP_ENV_VALIDATION is unset', async () => {
    delete process.env.SKIP_ENV_VALIDATION
    vi.resetModules()

    const mod: { skipValidation: boolean } = await import('./index')
    expect(mod.skipValidation).toBe(false)
  })

  /**
   * Test skipValidation is false when SKIP_ENV_VALIDATION is 'false'
   * **Validates: Requirement 6.1**
   */
  it('skipValidation is false when SKIP_ENV_VALIDATION is "false"', async () => {
    process.env.SKIP_ENV_VALIDATION = 'false'
    vi.resetModules()

    const mod: { skipValidation: boolean } = await import('./index')
    expect(mod.skipValidation).toBe(false)
  })

  /**
   * Test skipValidation is true when SKIP_ENV_VALIDATION is 'true'
   * **Validates: Requirement 6.1**
   */
  it('skipValidation is true when SKIP_ENV_VALIDATION is "true"', async () => {
    process.env.SKIP_ENV_VALIDATION = 'true'
    vi.resetModules()

    const mod: { skipValidation: boolean } = await import('./index')
    expect(mod.skipValidation).toBe(true)
  })

  /**
   * Test createSafeEnv is exported and callable
   * **Validates: Requirement 7.1**
   */
  it('createSafeEnv is exported and is a function', async () => {
    vi.resetModules()
    const mod: { createSafeEnv: unknown } = await import('./index')
    expect(mod.createSafeEnv).toBeDefined()
    expect(typeof mod.createSafeEnv).toBe('function')
  })
})
