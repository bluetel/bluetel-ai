import { describe, expect, it } from 'vitest'

import { formatTimestamp, NEVER } from './format-timestamp'

describe('formatTimestamp', () => {
  it('renders a timestamp to the minute, in UTC, with no zone suffix', () => {
    expect(formatTimestamp(new Date('2026-08-05T09:14:22.031Z'))).toBe('2026-08-05 09:14')
  })

  it('renders midnight without collapsing to a bare date', () => {
    expect(formatTimestamp(new Date('2026-08-05T00:00:00.000Z'))).toBe('2026-08-05 00:00')
  })

  it.each([null, undefined])('renders %s as a word rather than an empty cell', (value) => {
    expect(formatTimestamp(value)).toBe(NEVER)
  })

  it('renders an invalid date as never rather than as "Invalid Date"', () => {
    expect(formatTimestamp(new Date('not a date'))).toBe(NEVER)
  })

  it('produces a fixed width, which is what lets a column of them be scanned', () => {
    const widths = [
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-12-31T23:59:59Z'),
      new Date('1999-06-15T07:05:00Z'),
    ].map((value) => formatTimestamp(value).length)

    expect(new Set(widths).size).toBe(1)
  })

  it('does not depend on the runtime locale, so server and client renders agree', () => {
    // A locale-aware render would differ between an `en-GB` server and an `en-US` browser and
    // React would report a hydration mismatch on a value nobody chose.
    expect(formatTimestamp(new Date('2026-08-05T09:14:00Z'))).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    )
  })
})
