import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { MIN_SECRET_LENGTH, secretEncodings } from './secret-encodings'

/**
 * Synthetic throughout. Nothing in this file is, resembles, or could be
 * mistaken for a credential belonging to any real service.
 */
const SECRET = 'not-a-real-secret-value-0123456789'

describe('secretEncodings', () => {
  it('always includes the value itself', () => {
    expect(secretEncodings(SECRET)).toContain(SECRET)
  })

  it('ignores a value too short to be a credential', () => {
    expect(secretEncodings('ab')).toStrictEqual([])
    expect(secretEncodings('x'.repeat(MIN_SECRET_LENGTH))).not.toStrictEqual([])
  })

  it('covers standalone base64', () => {
    const encoded = Buffer.from(SECRET, 'utf8').toString('base64')
    const forms = secretEncodings(SECRET)

    expect(forms.some((form) => encoded.includes(form))).toBe(true)
  })

  it('covers base64 at every byte alignment inside a larger blob', () => {
    const forms = secretEncodings(SECRET)

    for (const prefix of ['', 'a', 'ab', 'abc']) {
      const blob = Buffer.from(`${prefix}${SECRET}trailing`, 'utf8').toString('base64')

      expect(forms.some((form) => blob.includes(form))).toBe(true)
    }
  })

  it('covers the URL-safe base64 alphabet', () => {
    const value = 'secret??>>value-with-plus-and-slash-bytes'
    const standard = Buffer.from(value, 'utf8').toString('base64')
    const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_')
    const forms = secretEncodings(value)

    expect(forms.some((form) => urlSafe.includes(form))).toBe(true)
  })

  it('covers percent-encoding in both hex cases', () => {
    const value = 'secret value/with+symbols'
    const forms = secretEncodings(value)

    expect(forms).toContain(encodeURIComponent(value))
    expect(forms).toContain(encodeURIComponent(value).replace(/%20/g, '+'))
    expect(forms.some((form) => form.includes('%2f') || form.includes('%2b'))).toBe(true)
  })

  it('covers JSON string escaping', () => {
    const value = 'secret"with\\escapes'

    expect(secretEncodings(value)).toContain(JSON.stringify(value).slice(1, -1))
  })

  it('covers hex in both cases', () => {
    const hex = Buffer.from(SECRET, 'utf8').toString('hex')
    const forms = secretEncodings(SECRET)

    expect(forms).toContain(hex)
    expect(forms).toContain(hex.toUpperCase())
  })

  it('returns the longest forms first so they win when applied in order', () => {
    const lengths = secretEncodings(SECRET).map((form) => form.length)

    expect(lengths).toStrictEqual([...lengths].sort((left, right) => right - left))
  })

  it('produces no duplicates', () => {
    const forms = secretEncodings(SECRET)

    expect(new Set(forms).size).toBe(forms.length)
  })
})
