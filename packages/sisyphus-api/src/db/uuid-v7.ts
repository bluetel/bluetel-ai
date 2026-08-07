import { randomBytes } from 'node:crypto'

/**
 * UUID version 7 — a 48-bit big-endian Unix millisecond timestamp followed by 74 random bits,
 * with the version and variant fields set per RFC 9562.
 *
 * Every primary key in this schema is a v7 rather than a v4 because the ids are also the physical
 * insert order: a time-ordered key appends to the right-hand edge of its B-tree instead of
 * scattering writes across the whole index, and `ORDER BY id` is a usable proxy for `ORDER BY
 * created_at` on the append-only tables.
 *
 * Generated in the application rather than by the database so that a row's id is known before the
 * insert — the workflow id goes into the compute lease tag, the S3 prefix and the scoped
 * credential's audience, all of which are decided before anything is written.
 */

const UUID_BYTE_LENGTH = 16
const TIMESTAMP_BYTE_LENGTH = 6
const RANDOM_BYTE_LENGTH = UUID_BYTE_LENGTH - TIMESTAMP_BYTE_LENGTH

/** Largest timestamp representable in 48 bits: 2^48 - 1 ms, i.e. some time in AD 10889. */
const MAX_TIMESTAMP_MS = 0xffffffffffff

const VERSION_BYTE_INDEX = 6
const VARIANT_BYTE_INDEX = 8

const toHex = (bytes: Uint8Array, start: number, end: number): string => {
  let hex = ''
  for (let index = start; index < end; index += 1) {
    hex += bytes[index].toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * Generate a UUID v7 string.
 *
 * @param timestampMs Unix epoch milliseconds; defaults to now. Exposed so tests can pin it.
 */
export const uuidV7 = (timestampMs: number = Date.now()): string => {
  if (!Number.isInteger(timestampMs) || timestampMs < 0 || timestampMs > MAX_TIMESTAMP_MS) {
    throw new RangeError(
      `uuidV7 needs a whole millisecond timestamp between 0 and ${String(MAX_TIMESTAMP_MS)}, received ${String(timestampMs)}`,
    )
  }

  const bytes = new Uint8Array(UUID_BYTE_LENGTH)

  // 48-bit big-endian timestamp across bytes 0..5.
  let remaining = timestampMs
  for (let index = TIMESTAMP_BYTE_LENGTH - 1; index >= 0; index -= 1) {
    bytes[index] = remaining % 256
    remaining = Math.floor(remaining / 256)
  }

  bytes.set(randomBytes(RANDOM_BYTE_LENGTH), TIMESTAMP_BYTE_LENGTH)

  // Version 7 in the high nibble of byte 6; RFC 9562 variant `10` in the top bits of byte 8.
  bytes[VERSION_BYTE_INDEX] = (bytes[VERSION_BYTE_INDEX] & 0x0f) | 0x70
  bytes[VARIANT_BYTE_INDEX] = (bytes[VARIANT_BYTE_INDEX] & 0x3f) | 0x80

  return [
    toHex(bytes, 0, 4),
    toHex(bytes, 4, 6),
    toHex(bytes, 6, 8),
    toHex(bytes, 8, 10),
    toHex(bytes, 10, 16),
  ].join('-')
}

/** Read the embedded millisecond timestamp back out of a v7 id. */
export const uuidV7TimestampMs = (id: string): number => {
  const hex = id.replace(/-/g, '').slice(0, 12)
  return Number.parseInt(hex, 16)
}
