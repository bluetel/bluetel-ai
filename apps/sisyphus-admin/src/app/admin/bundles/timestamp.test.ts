import { describe, expect, it } from 'vitest'

import { abbreviateDigest, formatBytes, formatTimestamp } from './timestamp'

describe('formatTimestamp', () => {
  it('renders UTC to the minute, in the one format the whole console uses', () => {
    expect(formatTimestamp(new Date('2026-08-05T14:03:27.512Z'))).toBe('2026-08-05 14:03 UTC')
  })

  it('does not depend on the host timezone, so server and browser agree', () => {
    // A locale format would produce a different string on either side of hydration, and two
    // operators comparing screenshots would disagree about when something happened.
    const rendered = formatTimestamp(new Date(Date.UTC(2026, 0, 1, 0, 0)))
    expect(rendered).toBe('2026-01-01 00:00 UTC')
    expect(rendered).not.toContain('/')
  })
})

describe('formatBytes', () => {
  it('reads small archives in bytes', () => {
    expect(formatBytes(512)).toBe('512 B')
  })

  it('steps up through binary units', () => {
    expect(formatBytes(2048)).toBe('2.0 KiB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GiB')
  })

  it('stops at GiB rather than inventing a unit', () => {
    expect(formatBytes(4096 * 1024 * 1024 * 1024)).toBe('4096.0 GiB')
  })

  it('renders a missing or nonsensical size as a dash rather than NaN', () => {
    expect(formatBytes(Number.NaN)).toBe('—')
    expect(formatBytes(-1)).toBe('—')
  })
})

describe('abbreviateDigest', () => {
  it('shows enough to compare by eye and marks that it is abbreviated', () => {
    expect(abbreviateDigest('a'.repeat(64))).toBe('aaaaaaaaaaaa…')
  })

  it('leaves a short value alone rather than adding a misleading ellipsis', () => {
    expect(abbreviateDigest('abc')).toBe('abc')
  })
})
