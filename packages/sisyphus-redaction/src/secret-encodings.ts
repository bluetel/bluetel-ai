/**
 * Encoded forms of a known credential value (T059, FR-045, FR-072).
 *
 * Known-value redaction only works on the forms it can recognise. A credential
 * that reaches the log after `JSON.stringify`, inside a URL query, or as part
 * of a base64 request body is the same secret and has to be caught the same
 * way — so each installed value is expanded into the encodings that cost
 * nothing to cover, and every expansion is redacted alongside the verbatim
 * value.
 *
 * Covered: verbatim, JSON string escaping, percent-encoding (upper- and
 * lower-case hex, and the `+`-for-space form), lower- and upper-case hex, and
 * base64 — standard and URL-safe alphabets, at all three byte alignments so a
 * value embedded inside a larger base64 blob still matches.
 *
 * Not covered, and deliberately: anything that is not a pure function of the
 * value alone. Compression, encryption, base64 broken across lines, base32,
 * and any encoding with a per-message key or salt produce output this module
 * cannot predict. Pattern matching and the private-key block filter are the
 * backstop for those.
 */

import { Buffer } from 'node:buffer'

/**
 * Shortest value worth treating as a secret. Below this, a "credential" is
 * more likely to be a placeholder than a key, and redacting every occurrence
 * of a three-character string would destroy the log it is meant to protect.
 */
export const MIN_SECRET_LENGTH = 6

/** Shortest encoded form worth matching. Short encodings collide with prose. */
const MIN_ENCODED_LENGTH = 8

/** Filler byte for base64 alignment. Its value never reaches the output. */
const ALIGNMENT_BYTE = 0x41

const toUrlSafeBase64 = (value: string): string => value.replace(/\+/g, '-').replace(/\//g, '_')

/**
 * The base64 fragments that depend only on the secret's own bytes.
 *
 * A secret encoded inside a larger blob starts at an arbitrary byte offset, and
 * base64 encodes three bytes at a time — so the same secret produces three
 * different character runs depending on its alignment. Each alignment is
 * generated with filler on both sides, then trimmed back to the character
 * groups that lie wholly inside the secret, leaving a fragment that appears
 * verbatim in the blob whatever surrounds it.
 */
const base64Fragments = (secret: string): readonly string[] => {
  const bytes = Buffer.from(secret, 'utf8')
  const fragments: string[] = []

  for (let alignment = 0; alignment < 3; alignment += 1) {
    const padded = Buffer.concat([
      Buffer.alloc(alignment, ALIGNMENT_BYTE),
      bytes,
      Buffer.alloc(2, ALIGNMENT_BYTE),
    ])
    const encoded = padded.toString('base64')
    const start = 4 * Math.ceil(alignment / 3)
    const end = 4 * Math.floor((alignment + bytes.length) / 3)
    const fragment = encoded.slice(start, end)

    if (fragment.length >= MIN_ENCODED_LENGTH) {
      fragments.push(fragment)
      fragments.push(toUrlSafeBase64(fragment))
    }
  }

  return fragments
}

const percentEncodings = (secret: string): readonly string[] => {
  const upper = encodeURIComponent(secret)

  return [
    upper,
    upper.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
    upper.replace(/%20/g, '+'),
    encodeURI(secret),
  ]
}

/**
 * Every form of `secret` the redactor should look for, longest first, with
 * duplicates and forms too short to be distinctive removed.
 */
export const secretEncodings = (secret: string): readonly string[] => {
  if (secret.length < MIN_SECRET_LENGTH) {
    return []
  }

  const hex = Buffer.from(secret, 'utf8').toString('hex')
  const candidates = [
    secret,
    JSON.stringify(secret).slice(1, -1),
    ...percentEncodings(secret),
    ...base64Fragments(secret),
    hex,
    hex.toUpperCase(),
  ]

  const unique = new Set<string>()

  for (const candidate of candidates) {
    if (candidate === secret || candidate.length >= MIN_ENCODED_LENGTH) {
      unique.add(candidate)
    }
  }

  return [...unique].sort((left, right) => right.length - left.length)
}
