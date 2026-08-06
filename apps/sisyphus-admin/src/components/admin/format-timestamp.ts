/**
 * Timestamps as machine readouts.
 *
 * Rendered in UTC, to the minute, in a fixed `YYYY-MM-DD HH:MM` shape. Three reasons, in order of
 * importance:
 *
 * 1. **It is a machine readout**, set in `data-mono` beside run ids and counts, and a locale-aware
 *    string in the middle of a mono column reads as prose that wandered in.
 * 2. **Operators compare these across rows.** A fixed-width form sorts and scans; `5 Aug 2026,
 *    10:14` does neither.
 * 3. **It renders identically on the server and in the browser.** `toLocaleString` does not: it
 *    reads the runtime's locale and zone, so the server's render and the client's hydration
 *    disagree, and React reports a mismatch on a value nobody deliberately chose.
 *
 * The trailing `Z` is dropped rather than kept — the whole console is UTC, so repeating it on
 * every row is noise. Where the zone matters, the column header says so.
 */

/** Cut `2026-08-05T09:14:22.031Z` down to `2026-08-05 09:14`. */
const ISO_MINUTE_WIDTH = 16

/** What a `null` timestamp reads as. A word, not an empty cell, so the row stays legible. */
export const NEVER = 'never'

/**
 * Render a timestamp, or `never` for an absent one.
 *
 * @param value - The timestamp, or `null` where the event has not happened — a user who has never
 *   signed in, a grant that has not been revoked.
 */
export const formatTimestamp = (value: Date | null | undefined): string => {
  if (value === null || value === undefined || Number.isNaN(value.getTime())) return NEVER

  return value.toISOString().slice(0, ISO_MINUTE_WIDTH).replace('T', ' ')
}
