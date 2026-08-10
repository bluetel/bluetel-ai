/**
 * The sequenced segment writer (T060, FR-045, FR-046, FR-047).
 *
 * The end of the output pipeline and the only thing in the executor allowed to
 * put run output anywhere durable. Everything it accepts is raw; everything it
 * emits has been through strip → redact → segment first, in that order, before
 * a single byte reaches storage or the wire. That ordering is the requirement:
 * a pipeline that writes raw bytes and sanitises them on read has already
 * failed, because the unsanitised copy existed.
 *
 * The ordering is enforced by the type system rather than by discipline. Both
 * sinks below take `SanitisedText`, which only `createSanitiser` can produce,
 * so there is no expression that hands raw output to either one.
 *
 * Three properties the rest of the platform depends on:
 *
 * - **Chunked, never dropped** (FR-047). Rate limiting paces delivery; it
 *   never discards. A chatty agent produces more segments, not fewer.
 * - **Stable sequences.** A segment's sequence is assigned when its body is
 *   cut, not when it is transmitted, and the record is retried unchanged. The
 *   machine surface is idempotent on `(workflowId, sequence)` and the panel
 *   reconciles by sequence rather than arrival time, so a sequence that
 *   shifted on retry would duplicate or reorder the log.
 * - **Storage before reporting.** `appendLogSegment` names an object key, so
 *   the object exists before the row that points at it.
 *
 * The two sinks are narrow on purpose. The real machine-surface client is T062
 * and the real object-storage client belongs to the AWS layer; neither is
 * implemented here, and neither needs to be for this to be testable.
 */

import type { SecretSource } from '@bluetel-ai/sisyphus-redaction'

import type { SanitisedText } from './sanitise'
import { createSanitiser, sanitisedByteLength } from './sanitise'
import { createTokenBucket } from './token-bucket'

/** What `appendLogSegment` is given once the body is durable (FR-046). */
export interface LogSegmentRecord {
  readonly workflowId: string
  /** Monotonic per workflow. Stable across retries. */
  readonly sequence: number
  readonly s3Key: string
  readonly byteSize: number
  readonly startedAt: Date
  readonly endedAt: Date
}

/**
 * Durable object storage for segment bodies (FR-046, FR-071).
 *
 * Accepts only sanitised text, which is what makes "nothing unsanitised at
 * rest" structural.
 */
export interface SegmentStore {
  readonly put: (input: { readonly key: string; readonly body: SanitisedText }) => Promise<void>
}

/** The machine surface's `appendLogSegment`, narrowed to what this needs. */
export interface SegmentReporter {
  readonly appendLogSegment: (record: LogSegmentRecord) => Promise<void>
}

export interface SegmentWriterOptions {
  readonly workflowId: string
  readonly store: SegmentStore
  readonly reporter: SegmentReporter
  /**
   * Every value this run knows.
   *
   * The credentials the setup bundle installed (FR-072), and — when a
   * re-readable source is passed — the agent's own credential as it stands
   * after any mid-run rotation (003/FR-014). This is the log, so this is the
   * option SC-014 actually turns on: nothing else in the executor writes agent
   * output anywhere durable.
   */
  readonly secrets?: SecretSource
  /** Cut a segment once its body reaches this many bytes. */
  readonly maxSegmentBytes?: number
  /** Sustained delivery rate. Paces; never drops. */
  readonly segmentsPerSecond?: number
  /** Segments deliverable at once after an idle period. */
  readonly burstSegments?: number
  /**
   * First sequence to issue. A restored run continues its predecessor's
   * numbering rather than restarting at zero, which would collide with
   * segments the machine surface already holds.
   */
  readonly startSequence?: number
  /** Key prefix within the workflow's partition. */
  readonly keyPrefix?: string
  /** Injected clock, for the rate limiter. */
  readonly now?: () => number
}

export interface SegmentWriter {
  /** Feed raw output. Sanitises, cuts and delivers what the rate allows. */
  readonly write: (chunk: string) => Promise<void>
  /**
   * Release everything held: the sanitiser's buffers, the partial segment, and
   * every queued segment, ignoring the rate limit. FR-047 requires this before
   * the process terminates for any reason. Rejects if delivery fails, leaving
   * the queue intact so the caller can retry.
   */
  readonly flush: () => Promise<void>
  /** Segments cut but not yet acknowledged by the reporter. */
  readonly queuedSegments: number
  /** The sequence the next cut segment will carry. */
  readonly nextSequence: number
}

interface QueuedSegment {
  readonly record: LogSegmentRecord
  readonly body: SanitisedText
}

const DEFAULT_MAX_SEGMENT_BYTES = 64 * 1024
const DEFAULT_SEGMENTS_PER_SECOND = 5
const DEFAULT_BURST_SEGMENTS = 10

/**
 * Largest prefix of `text` that fits in `maxBytes`, cut on a character
 * boundary and, where one is available in the back half, on a line boundary.
 * Splitting a surrogate pair would corrupt the character; splitting mid-line
 * merely reads badly, so the first is a correctness rule and the second a
 * courtesy.
 */
const cutLength = (text: SanitisedText, maxBytes: number): number => {
  let length = Math.min(text.length, maxBytes)

  while (length > 0 && sanitisedByteLength(text.slice(0, length) as SanitisedText) > maxBytes) {
    length -= 1
  }

  // Never leave a lone high surrogate at the end of a segment.
  if (length > 0 && length < text.length) {
    const code = text.charCodeAt(length - 1)

    if (code >= 0xd800 && code <= 0xdbff) {
      length -= 1
    }
  }

  const lastNewline = text.lastIndexOf('\n', length - 1)

  if (lastNewline >= Math.floor(length / 2)) {
    return lastNewline + 1
  }

  return length
}

export const createSegmentWriter = (options: SegmentWriterOptions): SegmentWriter => {
  const maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES
  const now = options.now ?? Date.now
  const keyPrefix = options.keyPrefix ?? `workflows/${options.workflowId}/logs`
  const sanitiser = createSanitiser(
    options.secrets === undefined ? {} : { secrets: options.secrets },
  )
  const limiter = createTokenBucket({
    ratePerSecond: options.segmentsPerSecond ?? DEFAULT_SEGMENTS_PER_SECOND,
    burst: options.burstSegments ?? DEFAULT_BURST_SEGMENTS,
    now,
  })

  const queue: QueuedSegment[] = []
  let buffer = '' as SanitisedText
  let bufferStartedAt: Date | undefined
  let sequence = options.startSequence ?? 0
  /** Serialises delivery so two writes cannot transmit the same segment twice. */
  let delivery: Promise<void> = Promise.resolve()

  const append = (text: SanitisedText): void => {
    if (text === '') {
      return
    }

    bufferStartedAt ??= new Date(now())
    buffer = (buffer + text) as SanitisedText
  }

  const cut = (length: number): void => {
    if (length <= 0) {
      return
    }

    const body = buffer.slice(0, length) as SanitisedText
    const startedAt = bufferStartedAt ?? new Date(now())

    buffer = buffer.slice(length) as SanitisedText
    bufferStartedAt = buffer === '' ? undefined : new Date(now())

    queue.push({
      body,
      record: {
        workflowId: options.workflowId,
        sequence,
        s3Key: `${keyPrefix}/${String(sequence).padStart(9, '0')}.log`,
        byteSize: sanitisedByteLength(body),
        startedAt,
        endedAt: new Date(now()),
      },
    })

    sequence += 1
  }

  /** Cut every whole segment the buffer can supply. Never drops the remainder. */
  const cutFullSegments = (): void => {
    while (sanitisedByteLength(buffer) >= maxSegmentBytes) {
      const length = cutLength(buffer, maxSegmentBytes)

      if (length <= 0) {
        return
      }

      cut(length)
    }
  }

  const deliverOne = async (segment: QueuedSegment): Promise<void> => {
    // Storage first: the reported row names an object key, so the object has
    // to exist before anything can be told to look for it.
    await options.store.put({ key: segment.record.s3Key, body: segment.body })
    await options.reporter.appendLogSegment(segment.record)
  }

  /**
   * Deliver from the head of the queue. `force` ignores the rate limit, which
   * is only correct on the terminal flush path.
   */
  const drain = async (force: boolean): Promise<void> => {
    while (queue.length > 0) {
      if (!force && !limiter.tryTake()) {
        return
      }

      // Left in place until it is acknowledged, so a retry re-sends the same
      // record with the same sequence rather than minting a new one.
      await deliverOne(queue[0])
      queue.shift()
    }
  }

  const enqueueDelivery = (force: boolean): Promise<void> => {
    delivery = delivery.then(
      () => drain(force),
      () => drain(force),
    )

    return delivery
  }

  return {
    write: async (chunk: string): Promise<void> => {
      append(sanitiser.push(chunk))
      cutFullSegments()

      try {
        await enqueueDelivery(false)
      } catch {
        // A transient reporting failure must not end the run. The segment
        // stays queued with its sequence and is retried on the next write or
        // on flush, which is where the failure becomes visible (FR-047).
      }
    },

    flush: async (): Promise<void> => {
      append(sanitiser.flush())
      cutFullSegments()
      cut(buffer.length)

      await enqueueDelivery(true)
    },

    get queuedSegments() {
      return queue.length
    },

    get nextSequence() {
      return sequence
    },
  }
}
