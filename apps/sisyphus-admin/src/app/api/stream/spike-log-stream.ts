/**
 * Spike S3 — live-log transport under connection pooling.
 *
 * The question R6 left open: `LISTEN/NOTIFY` only works on a **pinned session**, and
 * transaction-mode pooling does not give you one. The listener is handed a server connection for
 * the duration of the `LISTEN` statement and then loses it, so notifications are delivered to a
 * connection nobody is holding. Nothing errors. The stream simply goes quiet — which is why this
 * module scores every transport against segments *produced* rather than segments received, and why
 * {@link SegmentSubscription.listenEstablished} is reported separately from whether anything
 * arrived. "The LISTEN succeeded" and "the transport works" are different facts.
 *
 * Two transports are implemented behind one interface, matching R6's pre-chosen fallbacks:
 *
 * - `listen-notify` — the preferred design. Also the always-on-process fallback, which is the same
 *   code against a direct connection rather than a pooler.
 * - `poll-by-sequence` — the in-handler short poll of `log_segments` by `(workflow_id, sequence)`.
 *
 * Both emit {@link LogSegmentEvent}s reconciled by sequence, so the panel's SSE contract is
 * identical either way and the choice stays a transport decision.
 *
 * Nothing here ships to production: this is the measurement harness T065 implements against.
 */

import { randomUUID } from 'node:crypto'

import postgres from 'postgres'
import type { Sql } from 'postgres'

import type { LatencySummary } from './latency-stats'
import { summariseLatencies } from './latency-stats'
import type { LogSegmentEvent, SequenceReconciler } from './log-segment-event'
import {
  createSequenceReconciler,
  decodeNotifyPayload,
  LOG_SEGMENT_CHANNEL,
} from './log-segment-event'
import { SPIKE_TAG_PREFIX } from './spike-fixture'

export type TransportName = 'listen-notify' | 'poll-by-sequence'

/** Fast enough that the poll interval is not the dominant term in a 5-second budget. */
export const DEFAULT_POLL_INTERVAL_MS = 250

/** Long enough after the last write to judge the 5-second budget honestly. */
export const DEFAULT_SETTLE_MS = 6_000

/**
 * `prepare: false` uniformly, and two connections rather than one.
 *
 * Prepared statements are disabled because PgBouncer in transaction mode cannot carry them across
 * a connection hand-back; leaving them on would make the pooled run fail for a reason that has
 * nothing to do with `LISTEN/NOTIFY`, and confound the experiment. The second connection exists
 * because `listen` reserves one, leaving nothing for the backfill query otherwise.
 */
const connect = (connectionString: string): Sql =>
  postgres(connectionString, {
    max: 2,
    prepare: false,
    connect_timeout: 10,
    onnotice: () => {
      // A pooler's notices are noise here; the transport's silence is the signal.
    },
  })

const toError = (thrown: unknown): Error =>
  thrown instanceof Error ? thrown : new Error(String(thrown))

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

interface SegmentRow {
  workflow_id: string
  sequence: string | number | bigint
  s3_key: string
  byte_size: string | number | bigint
}

/**
 * `bigint` columns come back as strings from the driver, and `sequence` is the reconciliation key.
 * Comparing `'10' > '9'` lexicographically would silently reorder the log at the ten-segment mark.
 */
export const mapSegmentRow = (row: SegmentRow): LogSegmentEvent => ({
  workflowId: row.workflow_id,
  sequence: Number(row.sequence),
  s3Key: row.s3_key,
  byteSize: Number(row.byte_size),
})

const fetchSegmentsAfter = async (
  sql: Sql,
  workflowId: string,
  afterSequence: number,
): Promise<LogSegmentEvent[]> => {
  const rows = await sql<SegmentRow[]>`
    select workflow_id, sequence, s3_key, byte_size
    from log_segments
    where workflow_id = ${workflowId} and sequence > ${afterSequence}
    order by sequence asc
  `
  return rows.map(mapSegmentRow)
}

/**
 * Insert and notify in one statement.
 *
 * `NOTIFY` is transactional — it fires on commit — so a notification can never arrive describing a
 * row a reader cannot yet see. Doing it in the same statement as the insert also means the
 * producer is identical across every scenario, so only the consumer's transport varies.
 */
export const publishSegment = async (
  sql: Sql,
  workflowId: string,
  sequence: number,
  byteSize = 512,
): Promise<void> => {
  const s3Key = `${SPIKE_TAG_PREFIX}/${workflowId}/${sequence}.log`
  await sql`
    with inserted as (
      insert into log_segments (id, workflow_id, sequence, s3_key, byte_size, started_at, ended_at)
      values (${randomUUID()}, ${workflowId}, ${sequence}, ${s3Key}, ${byteSize}, now(), now())
      returning workflow_id, sequence, s3_key, byte_size
    )
    select pg_notify(
      ${LOG_SEGMENT_CHANNEL},
      json_build_object(
        'workflowId', workflow_id,
        'sequence', sequence,
        's3Key', s3_key,
        'byteSize', byte_size
      )::text
    )
    from inserted
  `
}

export interface SegmentSubscriptionOptions {
  readonly connectionString: string
  readonly workflowId: string
  /** The client's high-water mark. A reconnect passes its last rendered sequence. */
  readonly fromSequence: number
  readonly transport: TransportName
  readonly pollIntervalMs?: number
  /**
   * Read `log_segments` from `fromSequence` on connect before going live.
   *
   * Off is not a realistic production setting — it exists so the spike can show what a pure
   * live-tail loses across a recycle, which is the whole argument for reconciling by sequence.
   */
  readonly backfillOnConnect?: boolean
  readonly onSegment: (event: LogSegmentEvent, observedAtMs: number) => void
  readonly onTransportError: (error: Error) => void
}

export interface SegmentSubscription {
  readonly transport: TransportName
  /**
   * Whether the `LISTEN` statement itself succeeded — `null` for polling.
   *
   * The loud-versus-silent evidence. `true` here with zero segments delivered is the silent
   * failure R6 warned about.
   */
  readonly listenEstablished: boolean | null
  readonly lastSequence: () => number
  readonly reconciler: SequenceReconciler
  readonly stop: () => Promise<void>
}

interface BufferedNotification {
  readonly event: LogSegmentEvent
  readonly observedAtMs: number
}

const openListenNotifySubscription = async (
  options: SegmentSubscriptionOptions,
): Promise<SegmentSubscription> => {
  const sql = connect(options.connectionString)
  const reconciler = createSequenceReconciler(options.fromSequence)
  const backfillOnConnect = options.backfillOnConnect ?? true

  const deliver = (event: LogSegmentEvent, observedAtMs: number): void => {
    if (reconciler.accept(event) === 'emit') options.onSegment(event, observedAtMs)
  }

  /**
   * Notifications that land while the backfill query is still running are held, not dropped and
   * not delivered early: delivering early would advance the reconciler past rows the backfill has
   * not read yet and open a permanent hole.
   */
  const buffered: BufferedNotification[] = []
  let backfilling = backfillOnConnect
  let listenEstablished = false

  try {
    await sql.listen(LOG_SEGMENT_CHANNEL, (payload) => {
      const observedAtMs = Date.now()
      const event = decodeNotifyPayload(payload)
      if (event === null || event.workflowId !== options.workflowId) return
      if (backfilling) {
        buffered.push({ event, observedAtMs })
        return
      }
      deliver(event, observedAtMs)
    })
    listenEstablished = true
  } catch (error) {
    options.onTransportError(toError(error))
  }

  if (backfillOnConnect) {
    try {
      const events = await fetchSegmentsAfter(sql, options.workflowId, options.fromSequence)
      const observedAtMs = Date.now()
      for (const event of events) deliver(event, observedAtMs)
    } catch (error) {
      options.onTransportError(toError(error))
    }
    backfilling = false
    for (const held of buffered) deliver(held.event, held.observedAtMs)
    buffered.length = 0
  }

  return {
    transport: 'listen-notify',
    listenEstablished,
    lastSequence: () => reconciler.lastSequence(),
    reconciler,
    stop: async () => {
      await sql.end({ timeout: 5 })
    },
  }
}

const openPollingSubscription = async (
  options: SegmentSubscriptionOptions,
): Promise<SegmentSubscription> => {
  const sql = connect(options.connectionString)
  const reconciler = createSequenceReconciler(options.fromSequence)
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  let stopped = false
  let inFlight = false

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return
    inFlight = true
    try {
      const events = await fetchSegmentsAfter(sql, options.workflowId, reconciler.lastSequence())
      const observedAtMs = Date.now()
      for (const event of events) {
        if (reconciler.accept(event) === 'emit') options.onSegment(event, observedAtMs)
      }
    } catch (error) {
      options.onTransportError(toError(error))
    } finally {
      inFlight = false
    }
  }

  // The first read is the backfill; polling needs no separate catch-up path.
  if (options.backfillOnConnect ?? true) await tick()

  const timer = setInterval(() => {
    void tick()
  }, intervalMs)

  return {
    transport: 'poll-by-sequence',
    listenEstablished: null,
    lastSequence: () => reconciler.lastSequence(),
    reconciler,
    stop: async () => {
      stopped = true
      clearInterval(timer)
      await sql.end({ timeout: 5 })
    },
  }
}

export const openSegmentSubscription = async (
  options: SegmentSubscriptionOptions,
): Promise<SegmentSubscription> =>
  options.transport === 'listen-notify'
    ? openListenNotifySubscription(options)
    : openPollingSubscription(options)

export interface ScenarioOptions {
  readonly label: string
  /** Always direct, in every scenario, so only the consumer's transport is under test. */
  readonly producerConnectionString: string
  readonly consumerConnectionString: string
  readonly transport: TransportName
  readonly workflowId: string
  readonly segmentCount: number
  readonly segmentsPerSecond: number
  readonly pollIntervalMs?: number
  readonly backfillOnConnect?: boolean
  /** Drop the consumer after this many segments — a serverless instance going away mid-stream. */
  readonly recycleAfterSegments?: number
  readonly recycleDowntimeMs?: number
  readonly settleMs?: number
}

export interface ScenarioResult {
  readonly label: string
  readonly transport: TransportName
  readonly producedCount: number
  readonly receivedCount: number
  readonly missingCount: number
  readonly missingSequences: readonly number[]
  /** Segments delivered more than once *across* subscriptions — reconnect double-render. */
  readonly duplicateCount: number
  readonly listenEstablished: boolean | null
  readonly transportErrors: readonly string[]
  readonly recycled: boolean
  readonly latency: LatencySummary
}

/**
 * Produce `segmentCount` segments at a fixed rate while a consumer reads them, and record the
 * per-segment latency distribution.
 *
 * Producer and consumer share a process, so `observedAt - producedAt` involves one clock and no
 * skew. Latency is measured from the moment the insert-and-notify statement returns, which is
 * after commit — the first instant a correct transport could possibly deliver.
 */
export const runTransportScenario = async (options: ScenarioOptions): Promise<ScenarioResult> => {
  const producer = connect(options.producerConnectionString)
  const producedAtBySequence = new Map<number, number>()
  const observedAtBySequence = new Map<number, number>()
  const transportErrors: string[] = []
  let duplicateCount = 0
  let recycled = false

  const onSegment = (event: LogSegmentEvent, observedAtMs: number): void => {
    if (observedAtBySequence.has(event.sequence)) {
      duplicateCount += 1
      return
    }
    observedAtBySequence.set(event.sequence, observedAtMs)
  }
  const onTransportError = (error: Error): void => {
    transportErrors.push(error.message)
  }

  const openFrom = async (fromSequence: number): Promise<SegmentSubscription> =>
    openSegmentSubscription({
      connectionString: options.consumerConnectionString,
      workflowId: options.workflowId,
      fromSequence,
      transport: options.transport,
      pollIntervalMs: options.pollIntervalMs,
      backfillOnConnect: options.backfillOnConnect,
      onSegment,
      onTransportError,
    })

  let subscription = await openFrom(0)
  const listenEstablished = subscription.listenEstablished
  let recycleCompleted: Promise<void> = Promise.resolve()

  /**
   * The recycle runs *concurrently* with production, and deliberately so: an instance that goes
   * away does not pause the executor writing to it. Blocking the producer for the downtime would
   * produce a downtime window with nothing in it, and every transport would look lossless.
   */
  const recycleConsumer = async (resumeFrom: number): Promise<void> => {
    await subscription.stop()
    await sleep(options.recycleDowntimeMs ?? 2_000)
    subscription = await openFrom(resumeFrom)
  }

  try {
    const gapMs = 1000 / options.segmentsPerSecond
    const startedAtMs = Date.now()

    for (let index = 0; index < options.segmentCount; index += 1) {
      const sequence = index + 1
      await publishSegment(producer, options.workflowId, sequence)
      producedAtBySequence.set(sequence, Date.now())

      if (options.recycleAfterSegments === sequence) {
        recycled = true
        recycleCompleted = recycleConsumer(Math.max(...observedAtBySequence.keys(), 0)).catch(
          (error: unknown) => {
            onTransportError(toError(error))
          },
        )
      }

      const nextAtMs = startedAtMs + (index + 1) * gapMs
      const delayMs = nextAtMs - Date.now()
      if (delayMs > 0) await sleep(delayMs)
    }

    await recycleCompleted
    await sleep(options.settleMs ?? DEFAULT_SETTLE_MS)
  } finally {
    await recycleCompleted
    await subscription.stop()
    await producer.end({ timeout: 5 })
  }

  const latencies: number[] = []
  const missingSequences: number[] = []
  for (const [sequence, producedAtMs] of producedAtBySequence) {
    const observedAtMs = observedAtBySequence.get(sequence)
    if (observedAtMs === undefined) missingSequences.push(sequence)
    else latencies.push(observedAtMs - producedAtMs)
  }

  return {
    label: options.label,
    transport: options.transport,
    producedCount: producedAtBySequence.size,
    receivedCount: observedAtBySequence.size,
    missingCount: missingSequences.length,
    missingSequences,
    duplicateCount,
    listenEstablished,
    transportErrors,
    recycled,
    latency: summariseLatencies(latencies, producedAtBySequence.size),
  }
}
