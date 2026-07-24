import { describe, it, expect } from 'vitest'

import { formatFileSize } from './format-file-size'

describe('formatFileSize', () => {
  it('returns "0 B" for 0 bytes', () => {
    expect(formatFileSize(0)).toBe('0 B')
  })

  it('returns bytes for values less than 1024', () => {
    expect(formatFileSize(1)).toBe('1 B')
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1023)).toBe('1023 B')
  })

  it('returns KB for values >= 1024 and < 1MB', () => {
    expect(formatFileSize(1024)).toBe('1 KB')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(10240)).toBe('10 KB')
  })

  it('returns MB for values >= 1MB and < 1GB', () => {
    expect(formatFileSize(1048576)).toBe('1 MB')
    expect(formatFileSize(3355443)).toBe('3.2 MB')
    expect(formatFileSize(5242880)).toBe('5 MB')
  })

  it('returns GB for values >= 1GB', () => {
    expect(formatFileSize(1073741824)).toBe('1 GB')
    expect(formatFileSize(1610612736)).toBe('1.5 GB')
  })

  it('rounds to at most 2 decimal places', () => {
    // 1.999 KB = 2047.xxx bytes -> should round
    expect(formatFileSize(2048 + 512)).toBe('2.5 KB')
    // Exact boundary
    expect(formatFileSize(1024 * 1024 * 1.55)).toBe('1.55 MB')
  })

  it('removes trailing zeros from decimal places', () => {
    // 1.50 should display as "1.5", not "1.50"
    expect(formatFileSize(1536)).toBe('1.5 KB')
    // Whole numbers should not have decimals
    expect(formatFileSize(2048)).toBe('2 KB')
  })

  it('uses the largest unit where numeric value >= 1', () => {
    // Exactly 1 GB
    expect(formatFileSize(1073741824)).toBe('1 GB')
    // Just under 1 GB should be MB
    expect(formatFileSize(1073741823)).toBe('1024 MB')
  })
})
