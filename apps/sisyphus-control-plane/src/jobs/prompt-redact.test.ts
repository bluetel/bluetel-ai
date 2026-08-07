// Prefix of a synthetic Atlassian token fixture. File-scoped so the dictionary never legitimises a
// real credential shape repo-wide.
// cspell:ignore ATATT
import type { PromptParts } from '@bluetel-ai/sisyphus-api/contracts'
import { describe, expect, it } from 'vitest'

import type { PromptRedactor } from './prompt-redact'
import {
  assertRedactorConformance,
  boundComments,
  checkRedactorConformance,
  conformanceCasesFor,
  createRefusingPromptRedactor,
  DEFAULT_STORED_COMMENTS,
  PROMPT_REDACTOR_NOT_CONFIGURED,
  redactPromptParts,
  REDACTION_CONFORMANCE_CASES,
} from './prompt-redact'

/* cspell:ignore AKIA AKIAFIXTUREONLY redactor */

/**
 * A redactor good enough to pass the corpus, standing in for the executor's.
 *
 * It is **not** a second implementation of the standard and is not exported: it exists so the
 * corpus can be shown to pass as well as to fail, which is the only way to know the corpus is
 * discriminating rather than merely strict.
 */
const createStandInRedactor = (knownValues: readonly string[] = []): PromptRedactor => ({
  redact: (text) => {
    let output = text.replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[redacted:private-key]',
    )

    for (const value of knownValues) {
      for (const form of [value, Buffer.from(value, 'utf8').toString('base64')]) {
        output = output.split(form).join('[redacted:known]')
      }
    }

    output = output.replace(/\bAKIA[A-Z0-9]{16}\b/g, '[redacted:access-key-id]')
    output = output.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, '$1[redacted:bearer]')
    output = output.replace(
      /(\b[A-Za-z0-9_.-]*(?:token|secret|password|api_key)[A-Za-z0-9_.-]*\s*[:=]\s*)[^\s"',;]{6,}/gi,
      '$1[redacted:assigned]',
    )

    return output
  },
})

const partsOf = (overrides: Partial<PromptParts> = {}): PromptParts => ({
  title: 'Checkout total is wrong for multi-currency baskets',
  url: 'https://example.invalid/browse/FIX-1',
  body: 'The basket adds VAT twice.',
  comments: [],
  truncatedComments: 0,
  ...overrides,
})

describe('createRefusingPromptRedactor (FR-163)', () => {
  it('refuses rather than passing content through unredacted', () => {
    expect(() => createRefusingPromptRedactor().redact('anything')).toThrow(
      PROMPT_REDACTOR_NOT_CONFIGURED,
    )
  })

  it('fails the conformance check, so an unwired deployment cannot look configured', () => {
    expect(checkRedactorConformance(createRefusingPromptRedactor()).length).toBeGreaterThan(0)
  })
})

describe('the conformance corpus is the standard, stated as outcomes', () => {
  it('covers the key-block, pattern and header stages', () => {
    expect(REDACTION_CONFORMANCE_CASES.map((testCase) => testCase.name)).toEqual([
      'private-key-block',
      'access-key-id',
      'bearer-header',
      'assigned-secret',
    ])
  })

  it('adds the known-value stage only when a value is available to check it with', () => {
    expect(conformanceCasesFor().length).toBe(REDACTION_CONFORMANCE_CASES.length)
    expect(
      conformanceCasesFor('board-credential-fixture').map((testCase) => testCase.name),
    ).toContain('known-value-base64')
  })

  it('carries no real credential — every fixture value is invented', () => {
    for (const testCase of conformanceCasesFor('board-credential-fixture')) {
      expect(testCase.input).not.toMatch(/atlassian\.net|ATATT/)
    }
  })

  it('passes a redactor that meets the standard', () => {
    expect(
      checkRedactorConformance(createStandInRedactor(['board-credential-fixture']), {
        knownValue: 'board-credential-fixture',
      }),
    ).toEqual([])
  })

  it('fails a pass-through redactor, which is the injection this guards against', () => {
    const failures = checkRedactorConformance({ redact: (text) => text })

    // At least one failure per case; the key-block case contributes two fragments of its own.
    expect(failures.length).toBeGreaterThanOrEqual(REDACTION_CONFORMANCE_CASES.length)
    expect(failures[0]).toContain('the credential survived redaction')
  })

  it('fails a redactor that only covers patterns when a known value is in play', () => {
    const failures = checkRedactorConformance(createStandInRedactor(), {
      knownValue: 'board-credential-fixture',
    })

    expect(failures.some((failure) => failure.startsWith('known-value-verbatim'))).toBe(true)
  })

  it('fails a redactor that destroys the surrounding text along with the secret', () => {
    const failures = checkRedactorConformance({ redact: () => '' })

    expect(failures.some((failure) => failure.includes('surrounding content was destroyed'))).toBe(
      true,
    )
  })

  it('reports a throwing redactor as a failure rather than letting it escape', () => {
    const failures = checkRedactorConformance({
      redact: () => {
        throw new Error('no secret index')
      },
    })

    expect(failures[0]).toContain('the redactor threw')
  })

  it('assertRedactorConformance names every failing case', () => {
    expect(() => {
      assertRedactorConformance({ redact: (text) => text })
    }).toThrow(/private-key-block.*access-key-id/s)
  })

  it('assertRedactorConformance is silent when the standard is met', () => {
    expect(() => {
      assertRedactorConformance(createStandInRedactor())
    }).not.toThrow()
  })
})

describe('boundComments drops oldest-first and records the count (FR-163)', () => {
  it('keeps the newest comments that fit', () => {
    expect(boundComments(['aaaa', 'bbbb', 'cccc'], { maxCharacters: 8 })).toEqual({
      kept: ['bbbb', 'cccc'],
      dropped: 1,
    })
  })

  it('drops nothing when everything fits', () => {
    expect(boundComments(['one', 'two'])).toEqual({ kept: ['one', 'two'], dropped: 0 })
  })

  it('drops a comment larger than the whole budget rather than letting it evict the rest', () => {
    const result = boundComments(['x'.repeat(50), 'recent'], { maxCharacters: 20 })

    expect(result.kept).toEqual(['recent'])
    expect(result.dropped).toBe(1)
  })

  it('applies the count cap as well as the character cap', () => {
    const many = Array.from(
      { length: DEFAULT_STORED_COMMENTS + 3 },
      (_, index) => `c${String(index)}`,
    )
    const result = boundComments(many)

    expect(result.kept.length).toBe(DEFAULT_STORED_COMMENTS)
    expect(result.dropped).toBe(3)
    // Oldest-first: the survivors are the tail.
    expect(result.kept[result.kept.length - 1]).toBe(many[many.length - 1])
  })

  it('handles an empty comment list without reporting a truncation', () => {
    expect(boundComments([])).toEqual({ kept: [], dropped: 0 })
  })
})

describe('redactPromptParts (T116, FR-163)', () => {
  const redactor = createStandInRedactor(['board-credential-fixture'])

  it('redacts the title, the body and every comment', () => {
    const result = redactPromptParts(
      partsOf({
        title: 'Rotate AKIAFIXTUREONLY00000 please',
        body: 'api_token=board-credential-fixture is in the repo',
        comments: ['also AKIAFIXTUREONLY00000 here'],
      }),
      { redactor },
    )

    expect(result.title).not.toContain('AKIAFIXTUREONLY00000')
    expect(result.body).not.toContain('board-credential-fixture')
    expect(result.comments[0]).not.toContain('AKIAFIXTUREONLY00000')
  })

  it('redacts the URL too, because a link can carry a credential in its query string', () => {
    const result = redactPromptParts(
      partsOf({ url: 'https://example.invalid/browse/FIX-1?token=board-credential-fixture' }),
      { redactor },
    )

    expect(result.url).not.toContain('board-credential-fixture')
  })

  it('leaves a null body null rather than redacting the string "null"', () => {
    expect(redactPromptParts(partsOf({ body: null }), { redactor }).body).toBeNull()
  })

  it('adds its own drops to the count the connector already reported', () => {
    const result = redactPromptParts(
      partsOf({ comments: ['aaaa', 'bbbb', 'cccc'], truncatedComments: 7 }),
      { redactor, maxCharacters: 8 },
    )

    expect(result.comments).toEqual(['bbbb', 'cccc'])
    expect(result.truncatedComments).toBe(8)
  })

  it('never truncates the title, URL or description away, however tight the bound', () => {
    const result = redactPromptParts(partsOf({ comments: ['a', 'b'] }), {
      redactor,
      maxCharacters: 0,
    })

    expect(result.title).toContain('Checkout total')
    expect(result.url).toContain('FIX-1')
    expect(result.body).toContain('VAT twice')
    expect(result.comments).toEqual([])
    expect(result.truncatedComments).toBe(2)
  })

  it('bounds what is stored, so the budget is measured on the redacted text', () => {
    // The raw comment is well inside the budget; its redacted form is not.
    const expanding: PromptRedactor = { redact: (text) => text.replace('token', 'x'.repeat(40)) }
    const result = redactPromptParts(partsOf({ comments: ['token', 'kept'] }), {
      redactor: expanding,
      maxCharacters: 20,
    })

    expect(result.comments).toEqual(['kept'])
    expect(result.truncatedComments).toBe(1)
  })

  it('propagates a refusing redactor rather than storing anything', () => {
    expect(() =>
      redactPromptParts(partsOf(), { redactor: createRefusingPromptRedactor() }),
    ).toThrow(PROMPT_REDACTOR_NOT_CONFIGURED)
  })
})
