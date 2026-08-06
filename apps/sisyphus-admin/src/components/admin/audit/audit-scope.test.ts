import { describe, expect, it } from 'vitest'

import {
  EMPTY_AUDIT_SCOPE,
  hasInvalidSubject,
  hasSubject,
  isIdentifier,
  parseAuditScope,
  SUBJECT_PARAM,
  toAuditSearchParams,
  toRoleChangesInput,
} from './audit-scope'

/**
 * The audit view's one narrowing, across the three representations it lives in: the URL, the field's
 * draft value, and the procedure's input. Keeping all three conversions in one pure module is what
 * makes them testable — a subject that serialises to a key the parser does not read is a filter that
 * silently resets on reload, and no component test catches that.
 */

const SUBJECT = '0199a1f4-0000-7000-8000-0000000000ab'

describe('recognising an identifier', () => {
  it('accepts a UUID in either case', () => {
    expect(isIdentifier(SUBJECT)).toBe(true)
    expect(isIdentifier(SUBJECT.toUpperCase())).toBe(true)
  })

  it('accepts one with surrounding whitespace, because a paste carries it', () => {
    expect(isIdentifier(`  ${SUBJECT}  `)).toBe(true)
  })

  it('rejects an empty value, a name and a truncated id', () => {
    for (const value of ['', 'Ada Lovelace', SUBJECT.slice(0, 8), `${SUBJECT}x`]) {
      expect(isIdentifier(value)).toBe(false)
    }
  })
})

describe('the draft’s state', () => {
  it('treats an empty field as neither invalid nor a subject', () => {
    expect(hasInvalidSubject(EMPTY_AUDIT_SCOPE)).toBe(false)
    expect(hasSubject(EMPTY_AUDIT_SCOPE)).toBe(false)
  })

  it('marks a field holding something that is not an identifier', () => {
    expect(hasInvalidSubject({ subjectUserId: 'ada' })).toBe(true)
    expect(hasSubject({ subjectUserId: 'ada' })).toBe(false)
  })

  it('accepts a well-formed subject', () => {
    expect(hasInvalidSubject({ subjectUserId: SUBJECT })).toBe(false)
    expect(hasSubject({ subjectUserId: SUBJECT })).toBe(true)
  })
})

describe('reading the scope out of a URL', () => {
  it('reads a subject', () => {
    expect(parseAuditScope({ [SUBJECT_PARAM]: SUBJECT })).toStrictEqual({ subjectUserId: SUBJECT })
  })

  it('drops a subject a hand-edited URL invented, so a stale link reads rather than errors', () => {
    expect(parseAuditScope({ [SUBJECT_PARAM]: 'ada' })).toStrictEqual(EMPTY_AUDIT_SCOPE)
  })

  it('takes the first value when the key repeats', () => {
    expect(parseAuditScope({ [SUBJECT_PARAM]: [SUBJECT, 'other'] }).subjectUserId).toBe(SUBJECT)
  })

  it('reads an absent key as nothing narrowed', () => {
    expect(parseAuditScope({})).toStrictEqual(EMPTY_AUDIT_SCOPE)
  })
})

describe('writing the scope back into a URL', () => {
  it('round-trips a subject', () => {
    const query = toAuditSearchParams({ subjectUserId: SUBJECT })

    expect(query).toBe(`${SUBJECT_PARAM}=${SUBJECT}`)
    expect(parseAuditScope(Object.fromEntries(new URLSearchParams(query)))).toStrictEqual({
      subjectUserId: SUBJECT,
    })
  })

  it('contributes no key when nothing is narrowed, so a cleared field leaves no trace', () => {
    expect(toAuditSearchParams(EMPTY_AUDIT_SCOPE)).toBe('')
    expect(toAuditSearchParams({ subjectUserId: 'ada' })).toBe('')
  })
})

describe('the procedure input', () => {
  it('omits the subject entirely when there is none', () => {
    // Not `subjectUserId: undefined`: the whole-platform read and the narrowed one are two shapes.
    expect(toRoleChangesInput(EMPTY_AUDIT_SCOPE, 25)).toStrictEqual({ limit: 25 })
  })

  it('carries a trimmed subject when there is one', () => {
    expect(toRoleChangesInput({ subjectUserId: ` ${SUBJECT} ` }, 25)).toStrictEqual({
      limit: 25,
      subjectUserId: SUBJECT,
    })
  })

  it('never sends a subject that is not an identifier', () => {
    expect(toRoleChangesInput({ subjectUserId: 'ada' }, 25)).toStrictEqual({ limit: 25 })
  })
})
