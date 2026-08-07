/**
 * The two URLs the viewer talks to.
 *
 * Both are same-origin panel routes rather than anything the browser could be pointed at from
 * data: the workflow id comes from the page, and it is encoded rather than interpolated raw, so an
 * id that is not the uuid it is supposed to be cannot escape its path segment.
 *
 * They live in their own module because they are the one part of the client transport that is
 * worth asserting exactly — a viewer pointed at the wrong path fails at runtime only, and a
 * `fromSequence` dropped from the query string turns into a silently replayed log.
 */

/** Where the SSE stream lives. Must match `src/app/api/stream/[workflowId]/route.ts`. */
export const LOG_STREAM_PATH = '/api/stream'

/**
 * The stream URL, resuming strictly after `fromSequence`.
 *
 * The query parameter matters only for the **first** connection. `EventSource` replays the last
 * `id:` it saw as `Last-Event-ID` on every reconnect, and the route prefers that header — which is
 * the right precedence, because after a reconnect this URL is stale by definition.
 */
export const logStreamUrl = (workflowId: string, fromSequence: number): string =>
  `${LOG_STREAM_PATH}/${encodeURIComponent(workflowId)}?fromSequence=${String(Math.max(0, Math.trunc(fromSequence)))}`

/** Where one segment's stored output is read back as text. */
export const segmentTextUrl = (workflowId: string, sequence: number): string =>
  `${LOG_STREAM_PATH}/${encodeURIComponent(workflowId)}/segments/${String(Math.max(0, Math.trunc(sequence)))}`
