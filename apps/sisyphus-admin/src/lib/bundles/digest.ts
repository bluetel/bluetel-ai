import { createHash } from 'node:crypto'

/**
 * The archive's content digest.
 *
 * This is the integrity check the executor re-runs after downloading the archive, in the
 * `bundle_verify` bootstrap phase (contracts/setup-bundle.md). It is therefore taken from the
 * **bytes actually stored** — the same `Uint8Array` handed to the object store as the request body
 * — and never from a value the browser supplied. A digest computed anywhere else is a digest of
 * something other than what the executor will download, which is exactly the failure the check
 * exists to catch.
 */

/** Lower-case hex, matching the `contentDigest` schema and the `sha256sum` an author would run. */
export const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

/**
 * Base64, which is the encoding S3's `ChecksumSHA256` header takes.
 *
 * Sending it lets the store verify the transfer independently, so a truncated upload is rejected
 * by the storage layer rather than registered with a digest that matches bytes nobody will ever
 * download intact.
 */
export const sha256Base64 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('base64')

/**
 * The two-byte gzip magic number.
 *
 * The archive format is a gzipped tar (contracts/setup-bundle.md). Checking it here costs nothing
 * and turns "the admin uploaded a `.zip`" into a refusal at registration rather than into a
 * `bundle_unpack` failure on a paid instance twenty minutes later.
 */
export const looksGzipped = (bytes: Uint8Array): boolean =>
  bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
