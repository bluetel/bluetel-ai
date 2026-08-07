/**
 * The viewer's reconciliation — by `sequence`, never by arrival time (T077, FR-046, R6).
 *
 * ## Why arrival order is not usable
 *
 * Three separate things make it wrong, and only one of them is the network:
 *
 * 1. **Duplicates are the normal case.** `machine.appendLogSegment` is idempotent on
 *    `(workflow_id, sequence)` precisely so the executor can retry a flush it never got an answer
 *    for (FR-047). A retried flush and a resumed stream both replay a tail, so a viewer that
 *    appends what arrives renders the same output twice.
 * 2. **A reconnect re-reads.** Spike S3's control scenario showed a reconnect that does *not*
 *    re-read loses the downtime window, so the correct reconnect deliberately overlaps.
 * 3. **Backfill and live arrive together.** The archived read and the SSE stream both land in the
 *    first moments after mount, in whichever order they finish.
 *
 * So the sequence is the identity, and everything here is keyed on it. The rule matches the
 * server's `createSequenceReconciler`: the **first** record for a sequence wins, because the first
 * write wins in `log_segments` too — a later arrival claiming a different key for a sequence
 * already held is a bug on the instance, and quietly replacing the stored one would rewrite the
 * run's log after the fact.
 */

/** One segment as the viewer holds it — the SSE payload and the archived row have this shape. */
export interface LogSegmentRecord {
  readonly workflowId: string
  readonly sequence: number
  readonly s3Key: string
  readonly byteSize: number
}

const isUsable = (record: LogSegmentRecord): boolean =>
  Number.isSafeInteger(record.sequence) && record.sequence >= 0

/**
 * Merge new records into the held set.
 *
 * @param current - What the viewer already holds, ascending by sequence.
 * @param incoming - Anything newly arrived, in any order, possibly overlapping.
 * @returns The merged set, ascending. **The same array reference** when nothing changed, so a
 *   duplicate-only poll or a replayed tail costs no re-render — which matters when the transport
 *   is a 250 ms poll and overlap is designed in rather than incidental.
 */
export const reconcileSegments = (
  current: readonly LogSegmentRecord[],
  incoming: readonly LogSegmentRecord[],
): readonly LogSegmentRecord[] => {
  const bySequence = new Map(current.map((record) => [record.sequence, record]))
  let changed = false

  for (const record of incoming) {
    if (!isUsable(record) || bySequence.has(record.sequence)) {
      continue
    }
    bySequence.set(record.sequence, record)
    changed = true
  }

  if (!changed) {
    return current
  }

  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence)
}

/**
 * The highest sequence rendered so far — what a reconnect resumes **strictly after**.
 *
 * Read off the last element rather than tracked separately, so the mark cannot drift from what is
 * actually on screen. That is the whole safety property: resuming from a mark ahead of the render
 * would leave a hole no error reports.
 */
export const highWaterMark = (segments: readonly LogSegmentRecord[]): number =>
  segments.length === 0 ? 0 : (segments[segments.length - 1]?.sequence ?? 0)

/**
 * Sequences the held set is missing below its high-water mark.
 *
 * A gap means the log on screen is not continuous, and FR-046 requires one continuous ordered log.
 * The viewer says so rather than presenting a hole as if it were the output — a silently missing
 * segment reads as "the agent did nothing for a while", which is a different and wrong story.
 *
 * @param limit - Stop counting after this many, so a long backfill in flight does not walk a
 *   thousand-element range on every render.
 */
export const missingSequences = (
  segments: readonly LogSegmentRecord[],
  limit = 50,
): readonly number[] => {
  if (segments.length === 0) {
    return []
  }

  const held = new Set(segments.map((record) => record.sequence))
  const first = segments[0]?.sequence ?? 0
  const last = highWaterMark(segments)
  const missing: number[] = []

  for (let sequence = first; sequence <= last && missing.length < limit; sequence += 1) {
    if (!held.has(sequence)) {
      missing.push(sequence)
    }
  }

  return missing
}

/**
 * The most recent `size` segments.
 *
 * A run can produce thousands, and each rendered line resolves its own stored text — so the window
 * is what bounds both the DOM and the number of in-flight reads. It is the tail rather than the
 * head because a live log is read from the bottom.
 */
export const tailWindow = (
  segments: readonly LogSegmentRecord[],
  size: number,
): readonly LogSegmentRecord[] => (segments.length <= size ? segments : segments.slice(-size))
