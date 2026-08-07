import { TRPCError } from '@trpc/server'
import { and, eq } from 'drizzle-orm'

import type { LogSegment } from '../../db'
import { logSegments } from '../../db'
import type { AppendLogSegmentInput } from '../../schemas'

import type { MachineContext } from './guard'
import { firstRow } from './guard'

/**
 * `machine.appendLogSegment` — **idempotent on `(workflowId, sequence)`** (FR-046, FR-047).
 *
 * ## Why idempotence is the whole design
 *
 * The executor buffers and retries with backoff whenever the machine surface is unreachable
 * (FR-047), and "unreachable" includes the case where the write landed and the response did not.
 * The executor cannot tell those apart, so it retries, and a retry must be a **no-op** — not a
 * second row, and not an error either. A second row would duplicate output in the panel's
 * reconstructed log; an error would make a successful write look like a failure and push the
 * executor into a retry loop it can never leave.
 *
 * ## How
 *
 * `insert … on conflict (workflow_id, sequence) do nothing`, against the
 * `log_segments_sequence_key` unique index. The database decides, not the application: a
 * check-then-insert would race two concurrent flushes of the same buffered segment and one of them
 * would still get a unique violation. When the insert writes nothing the existing row is read back
 * and returned, so a retry and a first attempt produce the same response — which is what lets the
 * executor treat both as done and drop the segment from its buffer.
 *
 * The **first** write wins and is never overwritten. Segment content is sanitised and redacted
 * before it reaches S3 (FR-019, FR-045, FR-072), so a retry carrying different bytes for the same
 * sequence is a bug on the instance; silently replacing the stored key would hide it and rewrite
 * the run's log after the fact.
 */

/** What `appendLogSegment` answers with. */
export interface AppendedLogSegment {
  readonly segment: LogSegment
  /**
   * `false` when this sequence was already recorded and the call changed nothing. The executor
   * treats both outcomes as success; the flag exists so the difference is observable in tests and
   * in the reconciler rather than being invisible.
   */
  readonly created: boolean
}

/** A segment whose window runs backwards cannot be ordered against its neighbours. */
export const invalidSegmentWindowError = (): TRPCError =>
  new TRPCError({ code: 'BAD_REQUEST', message: 'A log segment cannot end before it started.' })

/**
 * Record one chunk of run output, at most once (FR-046, FR-047).
 *
 * Scoped to `ctx.workflowId` by construction: the workflow id written is the credential's, and the
 * payload has no field that could name another (see `./guard.ts`).
 *
 * @param ctx - The machine resolver context.
 * @param input - The validated `appendLogSegment` payload.
 */
export const appendLogSegment = async (
  ctx: MachineContext,
  input: AppendLogSegmentInput,
): Promise<AppendedLogSegment> => {
  if (input.endedAt.getTime() < input.startedAt.getTime()) {
    throw invalidSegmentWindowError()
  }

  const inserted = await ctx.db
    .insert(logSegments)
    .values({
      workflowId: ctx.workflowId,
      sequence: input.sequence,
      s3Key: input.s3Key,
      byteSize: input.byteSize,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
    })
    .onConflictDoNothing({ target: [logSegments.workflowId, logSegments.sequence] })
    .returning()

  const created = firstRow(inserted)
  if (created !== undefined) {
    return { segment: created, created: true }
  }

  const existing = firstRow(
    await ctx.db
      .select()
      .from(logSegments)
      .where(
        and(eq(logSegments.workflowId, ctx.workflowId), eq(logSegments.sequence, input.sequence)),
      )
      .limit(1),
  )

  if (existing === undefined) {
    // The insert conflicted, so a row with this key existed a moment ago; it can only be absent
    // now if something deleted it concurrently. Log segments are append-only, so this is a broken
    // invariant rather than a race worth retrying through.
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'The log segment could not be recorded.',
    })
  }

  return { segment: existing, created: false }
}
