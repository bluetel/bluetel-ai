import { logSegments } from '@bluetel-ai/sisyphus-api/db'
import type { ScopeIdentity } from '@bluetel-ai/sisyphus-api/server'
import { createScopeResolver, findWorkflowInScope } from '@bluetel-ai/sisyphus-api/server'
import { getAuthDatabase } from '@sisyphus-admin/lib/auth'
import { recordDenial, resolveSisyphusSession } from '@sisyphus-admin/server'
import { and, asc, eq, gt } from 'drizzle-orm'

import type { LogSegmentEvent } from '../log-segment-event'
import { formatSseFrame } from '../log-segment-event'
import { pollLogSegments } from '../log-segment-poll'
import { resolveResumePoint } from '../resume-point'
import {
  formatSseComment,
  formatSseRetry,
  formatStreamClosed,
  SSE_HEADERS,
  SSE_RETRY_MS,
} from '../sse'
import type { StreamWorkflow } from '../stream-access'
import { createRevalidatingScope, decideLogStreamAccess, refusalResponse } from '../stream-access'

/**
 * `logStream` — live run output over SSE (T065, FR-046, SC-002, api-surface.md).
 *
 * ## Transport
 *
 * An in-handler short poll of `log_segments` by `(workflow_id, sequence)`, per spike S3's verdict
 * (`../SPIKE-FINDINGS.md`). `LISTEN/NOTIFY` through a transaction-mode pooler delivered 0 of 300
 * notifications with no error of any kind, and leaked its registration into the pool. The SSE
 * contract is unchanged — `formatSseFrame` still puts the sequence in `id:`, so a reconnecting
 * `EventSource` resumes on the same key the transport reconciles on. The loop itself is in
 * `../log-segment-poll`, injected with both reads so it is testable without a database.
 *
 * ## Access
 *
 * Decided by `../stream-access` before a single byte of `text/event-stream` is written, from the
 * Auth.js session and `findWorkflowInScope`. A caller who may not see the run gets the **same**
 * `404 Workflow not found.` as one asking about a workflow that does not exist — same status, same
 * body, same headers, and decided by the same query, so there is nothing to tell apart (FR-190).
 * A streaming endpoint that skipped this because "it is only logs" would be a disclosure with a
 * different content type.
 *
 * Scope is then **re-checked while the stream is open**, on a five-second cadence, because a
 * connection that lasts an hour is one request and FR-184 says a revoked grant takes effect at the
 * next one. Losing sight of the run closes the stream immediately, with no further output.
 *
 * ## Closing
 *
 * Two ways, and both are load-bearing. On a **terminal state** the loop drains once more (a
 * buffered segment can land behind `reportTerminal` under FR-047) and then sends a
 * `log-stream-closed` frame, so the browser stops reconnecting against a finished run. On **client
 * disconnect** the `AbortSignal` interrupts the poll's wait and the generator returns without
 * writing anything — a poll loop that outlives its reader is a paid query every 250 ms that nobody
 * is watching.
 *
 * ## Module scope
 *
 * Nothing here evaluates a pool or reads a secret at import. `next build` imports every route
 * module while collecting page data, so `getAuthDatabase()` is called inside the handler.
 */

/** The stream is per-request and per-caller; nothing about it may be statically rendered. */
export const dynamic = 'force-dynamic'

/** Rows come back with `bigint` columns as strings; `sequence` is the reconciliation key. */
interface SegmentRow {
  readonly workflowId: string
  readonly sequence: string | number
  readonly s3Key: string
  readonly byteSize: string | number
}

/**
 * Map a row to the wire shape.
 *
 * `Number(...)` on `sequence` is not cosmetic: comparing the driver's strings would order `'10'`
 * before `'9'` and silently reorder the log at the ten-segment mark.
 */
export const toLogSegmentEvent = (row: SegmentRow): LogSegmentEvent => ({
  workflowId: row.workflowId,
  sequence: Number(row.sequence),
  s3Key: row.s3Key,
  byteSize: Number(row.byteSize),
})

const encoder = new TextEncoder()

export const GET = async (
  request: Request,
  context: { readonly params: Promise<{ readonly workflowId: string }> },
): Promise<Response> => {
  const { workflowId } = await context.params
  const db = getAuthDatabase()
  const session = await resolveSisyphusSession()

  const resolveScopeFor = (identity: ScopeIdentity) =>
    createScopeResolver({ db, identity }).resolve()

  const access = await decideLogStreamAccess({
    session,
    workflowId,
    findWorkflowInScope: async (identity, id): Promise<StreamWorkflow | undefined> => {
      const workflow = await findWorkflowInScope({
        db,
        scope: await resolveScopeFor(identity),
        workflowId: id,
      })
      return workflow === undefined ? undefined : { id: workflow.id, state: workflow.state }
    },
  })

  if (access.outcome !== 'granted') {
    if (access.outcome === 'inactive') {
      // Someone is using credentials that were taken away. `authedProcedure` records this and so
      // does the stream, because a refusal that only the tRPC surface reports is half an audit
      // trail (FR-175).
      await recordDenial({
        reason: 'inactive_user',
        userId: access.userId,
        path: 'logStream',
      })
    }
    return refusalResponse(access)
  }

  const runId = access.workflow.id
  const fromSequence = resolveResumePoint(request)

  // Re-resolved every five seconds rather than memoised for the life of the connection, so a
  // revoked grant lands mid-stream (FR-184).
  const scope = createRevalidatingScope({
    identity: access.identity,
    resolve: resolveScopeFor,
  })

  const controller = new AbortController()
  request.signal.addEventListener('abort', () => {
    controller.abort()
  })

  const messages = pollLogSegments({
    fromSequence,
    signal: controller.signal,
    readSegmentsAfter: async (afterSequence, limit) => {
      const rows = await db
        .select({
          workflowId: logSegments.workflowId,
          sequence: logSegments.sequence,
          s3Key: logSegments.s3Key,
          byteSize: logSegments.byteSize,
        })
        .from(logSegments)
        .where(and(eq(logSegments.workflowId, runId), gt(logSegments.sequence, afterSequence)))
        .orderBy(asc(logSegments.sequence))
        .limit(limit)

      return rows.map(toLogSegmentEvent)
    },
    readWorkflowState: async () => {
      const workflow = await findWorkflowInScope({
        db,
        scope: await scope.resolve(),
        workflowId: runId,
      })
      return workflow?.state
    },
  })

  const pump = async (streamController: ReadableStreamDefaultController<Uint8Array>) => {
    const write = (frame: string) => {
      streamController.enqueue(encoder.encode(frame))
    }

    try {
      write(formatSseRetry(SSE_RETRY_MS))

      for await (const message of messages) {
        switch (message.kind) {
          case 'segment':
            write(formatSseFrame(message.event))
            break
          case 'keepalive':
            write(formatSseComment('open'))
            break
          case 'closed':
            write(formatStreamClosed(message.reason))
            break
        }
      }
    } catch {
      // A failed read ends the stream rather than propagating: the browser reconnects after
      // `SSE_RETRY_MS` and backfills by sequence, so a transient database error costs a gap of one
      // retry and loses nothing. Nothing is written about it — the message could carry
      // executor-reported content, which FR-045 keeps out of platform logs.
    } finally {
      controller.abort()
      try {
        streamController.close()
      } catch {
        // The reader cancelled first, which already closed the controller. Closing a closed
        // controller throws, and an unhandled rejection here would be reported as a request
        // failure for a stream that ended exactly as intended.
      }
    }
  }

  const body = new ReadableStream<Uint8Array>({
    // Deliberately **not** an async `start`. A `start` that returns a promise is awaited before
    // the stream is considered started, and this one would not settle until the run ended — which
    // is the difference between a live log and a very slow download.
    start: (streamController) => {
      void pump(streamController)
    },
    cancel: () => {
      // The reader went away without the request aborting — a closed tab, a navigated page. Same
      // answer: stop paying for queries nobody will read.
      controller.abort()
    },
  })

  return new Response(body, { status: 200, headers: SSE_HEADERS })
}
