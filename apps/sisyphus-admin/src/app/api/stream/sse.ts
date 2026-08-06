/**
 * The SSE envelope: headers, the reconnect hint, keep-alive frames and the close frame.
 *
 * `formatSseFrame` in `./log-segment-event` already frames a segment, and it is unchanged — the
 * spike's verdict was a change of *transport*, not of contract. What is added here is everything
 * around the segments that a long-lived stream needs and a measurement harness did not.
 */

/** The SSE `event:` name a closing stream sends before it ends. */
export const LOG_STREAM_CLOSED_EVENT = 'log-stream-closed'

/**
 * Why a stream ended. Sent to the client, because the two mean opposite things to it.
 *
 * `terminal` — the run finished; there will never be another segment, so the viewer should stop
 * reconnecting and show the log as complete. `gone` — the run is no longer visible to this caller
 * (revoked mid-stream) or has disappeared; the viewer should stop too, and say so differently.
 */
export type StreamCloseReason = 'terminal' | 'gone'

/**
 * How long a browser should wait before reconnecting.
 *
 * Three seconds rather than `EventSource`'s ~3 s default made explicit, so the value is a decision
 * in this file rather than a browser's. It is deliberately longer than the 250 ms poll interval:
 * a reconnect storm across every open panel is the failure mode the polling transport is most
 * exposed to, and the reconnect always backfills by sequence so nothing is lost by waiting.
 */
export const SSE_RETRY_MS = 3_000

/**
 * How often a comment frame is sent when there is nothing to say.
 *
 * Proxies and load balancers close an idle connection, and a run can legitimately produce no
 * output for minutes. A comment line is ignored by `EventSource` and costs three bytes, so this is
 * the cheapest way to keep an idle stream from being reaped and rediscovered as a reconnect.
 */
export const SSE_KEEPALIVE_MS = 15_000

/**
 * The response headers for a live stream.
 *
 * `X-Accel-Buffering: no` is not superstition: an SSE stream that is buffered by an intermediary
 * is not a live log, and the spike explicitly did **not** test the CDN path — so the header that
 * asks every well-behaved proxy not to buffer is sent, and the edge question stays open rather
 * than being assumed away.
 */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/** A comment frame. Ignored by the client; exists only to keep the connection warm. */
export const formatSseComment = (text: string): string => `: ${text}\n\n`

/** The reconnect hint, sent once at the top of the stream. */
export const formatSseRetry = (milliseconds: number): string => `retry: ${String(milliseconds)}\n\n`

/**
 * The last frame a stream sends.
 *
 * Without it an `EventSource` reconnects for ever against a finished run, once every
 * {@link SSE_RETRY_MS}, each attempt costing a scope query and a segment read. The viewer closes
 * on this event, which is what turns "the run ended" into a client-side fact instead of a
 * connection that merely goes quiet.
 */
export const formatStreamClosed = (reason: StreamCloseReason): string =>
  [`event: ${LOG_STREAM_CLOSED_EVENT}`, `data: ${JSON.stringify({ reason })}`, '', ''].join('\n')
