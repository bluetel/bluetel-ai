import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { looksGzipped, sha256Base64, sha256Hex } from './digest'

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)

const gzipped = (...tail: number[]): Uint8Array => bytes(0x1f, 0x8b, ...tail)

describe('sha256Hex', () => {
  it('is the same value `sha256sum` prints, so a bundle author can check it by hand', () => {
    const payload = gzipped(1, 2, 3)
    expect(sha256Hex(payload)).toBe(createHash('sha256').update(payload).digest('hex'))
  })

  it('is lower-case hex of exactly 64 characters, which is what the schema accepts', () => {
    expect(sha256Hex(gzipped(9))).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when a single byte changes — this is the check the executor re-runs', () => {
    expect(sha256Hex(gzipped(1, 2, 3))).not.toBe(sha256Hex(gzipped(1, 2, 4)))
  })
})

describe('sha256Base64', () => {
  it('is the same digest in the encoding S3 takes for ChecksumSHA256', () => {
    const payload = gzipped(7, 7)
    expect(Buffer.from(sha256Base64(payload), 'base64').toString('hex')).toBe(sha256Hex(payload))
  })
})

describe('looksGzipped', () => {
  it('accepts the gzip magic number', () => {
    expect(looksGzipped(gzipped(8, 0, 0))).toBe(true)
  })

  it('rejects a zip, so the wrong archive format fails here rather than on a paid instance', () => {
    // `PK\x03\x04`.
    expect(looksGzipped(bytes(0x50, 0x4b, 0x03, 0x04))).toBe(false)
  })

  it('rejects a file too short to carry the magic number at all', () => {
    expect(looksGzipped(bytes(0x1f))).toBe(false)
    expect(looksGzipped(bytes())).toBe(false)
  })
})
