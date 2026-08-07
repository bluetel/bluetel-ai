/**
 * Timestamps, rendered the same on the server as in the browser.
 *
 * Deliberately **not** `toLocaleString`. The panel is server-rendered and then hydrated, so a
 * locale- or timezone-dependent format produces one string on the server and a different one in the
 * browser, which React reports as a hydration mismatch and which makes two operators comparing
 * screenshots disagree about when something happened. Everything in this console is UTC for the
 * same reason the database columns are.
 */

/** `2026-08-05 14:03 UTC` — minute precision, which is all an audit line needs. */
export const formatTimestamp = (value: Date): string =>
  `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** Bytes as a compact, unambiguous reading. Binary units, because that is what an archive is measured in. */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${String(bytes)} B`

  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'KiB'}`
}

/** How much of a digest is shown inline. Enough to compare by eye, never enough to retype wrongly. */
const DIGEST_PREVIEW_LENGTH = 12

/**
 * The first characters of a digest, marked as abbreviated.
 *
 * The full value stays available as the element's title; an operator checking an archive against
 * `sha256sum` needs all 64 characters and a truncated string presented as if it were complete is
 * worse than no digest at all.
 */
export const abbreviateDigest = (digest: string): string =>
  digest.length <= DIGEST_PREVIEW_LENGTH ? digest : `${digest.slice(0, DIGEST_PREVIEW_LENGTH)}…`
