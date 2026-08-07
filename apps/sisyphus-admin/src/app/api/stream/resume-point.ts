/**
 * Where a reconnecting stream picks up (spike S3, finding (g)).
 *
 * The spike's control scenario is the reason this module exists rather than being a default of
 * zero or a bare re-subscribe: a reconnect that simply starts listening again lost **30 of 150**
 * segments over a 3-second gap, with no error anywhere. The reconnect must be a
 * `sequence > lastRendered` read, so the resume point has to be recoverable from the request.
 *
 * `EventSource` sends the last `id:` it saw back as `Last-Event-ID`, and `formatSseFrame` puts the
 * segment's `sequence` in that field — so the browser resumes on the same key the transport
 * reconciles on, with no second identifier to keep in step. `?fromSequence=` is the fallback for a
 * first connection that already has a rendered prefix (a page that server-rendered the archived
 * log, or a client reconnecting with `fetch` rather than `EventSource`).
 */

/** The header `EventSource` replays automatically on reconnect. */
export const LAST_EVENT_ID_HEADER = 'last-event-id'

/** The query parameter a caller uses when it is not an `EventSource`. */
export const FROM_SEQUENCE_PARAMETER = 'fromSequence'

/**
 * Parse one candidate into a high-water mark.
 *
 * Anything that is not a non-negative safe integer reads as `undefined` rather than as zero, so a
 * malformed header falls through to the query parameter instead of silently replaying the whole
 * log.
 */
const parseSequence = (value: string | null): number | undefined => {
  if (value === null) {
    return undefined
  }

  const trimmed = value.trim()
  if (trimmed === '' || !/^\d+$/.test(trimmed)) {
    return undefined
  }

  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/**
 * The sequence this connection has already rendered, or `0` for a fresh one.
 *
 * `Last-Event-ID` wins over the query parameter because it is the browser's own record of what it
 * displayed, and the URL is whatever the page was opened with — after a reconnect the URL is stale
 * by definition.
 *
 * @param request - The inbound request.
 * @returns A non-negative integer. Segments **strictly after** it are sent.
 */
export const resolveResumePoint = (request: Request): number => {
  const fromHeader = parseSequence(request.headers.get(LAST_EVENT_ID_HEADER))
  if (fromHeader !== undefined) {
    return fromHeader
  }

  const url = new URL(request.url)
  return parseSequence(url.searchParams.get(FROM_SEQUENCE_PARAMETER)) ?? 0
}
