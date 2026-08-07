import { writeFile } from 'node:fs/promises'

import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { formatLatencySummary } from './latency-stats'
import type { SpikeFixtureIdentifiers } from './spike-fixture'
import {
  buildFixtureIdentifiers,
  createSpikeWorkflow,
  seedSpikeFixture,
  teardownSpikeFixture,
} from './spike-fixture'
import type { ScenarioResult } from './spike-log-stream'
import { mapSegmentRow, runTransportScenario } from './spike-log-stream'

describe('mapSegmentRow', () => {
  it('coerces the bigint sequence the driver returns as a string', () => {
    const event = mapSegmentRow({
      workflow_id: 'w',
      sequence: '10',
      s3_key: 'k',
      byte_size: '4096',
    })
    expect(event.sequence).toBe(10)
    expect(event.byteSize).toBe(4096)
  })

  it('orders numerically, not lexicographically, once past nine segments', () => {
    const nine = mapSegmentRow({ workflow_id: 'w', sequence: '9', s3_key: 'k', byte_size: '1' })
    const ten = mapSegmentRow({ workflow_id: 'w', sequence: '10', s3_key: 'k', byte_size: '1' })
    expect(ten.sequence).toBeGreaterThan(nine.sequence)
  })

  it('accepts a native bigint if the driver is configured to return one', () => {
    const event = mapSegmentRow({
      workflow_id: 'w',
      sequence: BigInt(12),
      s3_key: 'k',
      byte_size: BigInt(8),
    })
    expect(event.sequence).toBe(12)
  })
})

/**
 * The live suite. Needs a real Postgres and, for the pooled scenarios, a PgBouncer in
 * `pool_mode = transaction` in front of it. Skipped cleanly when neither is present, so
 * `vitest run` is green on a machine with no database.
 *
 *   SPIKE_S3_DIRECT_URL=postgres://... \
 *   SPIKE_S3_POOLED_URL=postgres://...:6432/... \
 *   pnpm exec vitest run src/app/api/stream
 */
const directUrl = process.env.SPIKE_S3_DIRECT_URL ?? ''
const pooledUrl = process.env.SPIKE_S3_POOLED_URL ?? ''
const hasDirect = directUrl.length > 0
const hasPooled = pooledUrl.length > 0

const segmentCount = Number(process.env.SPIKE_S3_SEGMENTS ?? '300')
const recycleSegmentCount = Number(process.env.SPIKE_S3_RECYCLE_SEGMENTS ?? '150')
const segmentsPerSecond = Number(process.env.SPIKE_S3_RATE ?? '10')
const scenarioTimeoutMs = 300_000

const results: ScenarioResult[] = []

const record = (result: ScenarioResult): ScenarioResult => {
  results.push(result)
  return result
}

describe.skipIf(!hasDirect)('spike S3 — live-log transport under connection pooling', () => {
  const identifiers: SpikeFixtureIdentifiers = buildFixtureIdentifiers()
  const admin = postgres(directUrl, { max: 1, prepare: false, onnotice: () => undefined })

  beforeAll(async () => {
    await seedSpikeFixture(admin, identifiers)
  }, 60_000)

  afterAll(async () => {
    await teardownSpikeFixture(admin, identifiers)
    await admin.end({ timeout: 5 })

    const lines = results.map((result) => {
      const detail = [
        `listen=${String(result.listenEstablished)}`,
        `missing=${result.missingCount}`,
        `dupes=${result.duplicateCount}`,
        `errors=${result.transportErrors.length}`,
      ].join('  ')
      return `${formatLatencySummary(result.label, result.latency)}  ${detail}`
    })

    console.log(lines.join('\n'))
    // The measurements are the deliverable, and a runner that swallows hook stdout would lose
    // them. Written only when a path is given, so the gated suite still writes nothing by default.
    const resultsPath = process.env.SPIKE_S3_RESULTS_PATH ?? ''
    if (resultsPath.length > 0) {
      await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n${lines.join('\n')}\n`)
    }
  }, 60_000)

  it.skipIf(!hasPooled)(
    '(a) LISTEN/NOTIFY through a transaction-mode pooler',
    async () => {
      const result = record(
        await runTransportScenario({
          label: 'a) listen-notify / pooled',
          producerConnectionString: directUrl,
          consumerConnectionString: pooledUrl,
          transport: 'listen-notify',
          workflowId: await createSpikeWorkflow(admin, identifiers),
          segmentCount,
          segmentsPerSecond,
          // The connect-time backfill would mask the transport, so this run is live-tail only.
          backfillOnConnect: false,
        }),
      )
      expect(result.producedCount).toBe(segmentCount)
      // The finding, asserted so a future pooler change cannot quietly invalidate it: the LISTEN
      // statement itself succeeds, and the stream still never meets SC-002.
      expect(result.listenEstablished).toBe(true)
      expect(result.latency.meetsSc002).toBe(false)
    },
    scenarioTimeoutMs,
  )

  it(
    '(b) LISTEN/NOTIFY on a direct pinned connection',
    async () => {
      const result = record(
        await runTransportScenario({
          label: 'b) listen-notify / direct',
          producerConnectionString: directUrl,
          consumerConnectionString: directUrl,
          transport: 'listen-notify',
          workflowId: await createSpikeWorkflow(admin, identifiers),
          segmentCount,
          segmentsPerSecond,
          backfillOnConnect: false,
        }),
      )
      expect(result.listenEstablished).toBe(true)
      expect(result.missingCount).toBe(0)
      expect(result.latency.meetsSc002).toBe(true)
    },
    scenarioTimeoutMs,
  )

  it.skipIf(!hasPooled)(
    '(c) poll by sequence through the pooler at 250ms',
    async () => {
      const result = record(
        await runTransportScenario({
          label: 'c) poll 250ms / pooled',
          producerConnectionString: directUrl,
          consumerConnectionString: pooledUrl,
          transport: 'poll-by-sequence',
          workflowId: await createSpikeWorkflow(admin, identifiers),
          segmentCount,
          segmentsPerSecond,
          pollIntervalMs: 250,
        }),
      )
      expect(result.missingCount).toBe(0)
      expect(result.duplicateCount).toBe(0)
      expect(result.latency.meetsSc002).toBe(true)
    },
    scenarioTimeoutMs,
  )

  it.skipIf(!hasPooled)(
    '(d) poll by sequence through the pooler at 1000ms',
    async () => {
      const result = record(
        await runTransportScenario({
          label: 'd) poll 1000ms / pooled',
          producerConnectionString: directUrl,
          consumerConnectionString: pooledUrl,
          transport: 'poll-by-sequence',
          workflowId: await createSpikeWorkflow(admin, identifiers),
          segmentCount,
          segmentsPerSecond,
          pollIntervalMs: 1_000,
        }),
      )
      expect(result.missingCount).toBe(0)
      expect(result.latency.meetsSc002).toBe(true)
    },
    scenarioTimeoutMs,
  )

  it.skipIf(!hasPooled)(
    '(e) recycle mid-stream: polling reconciles by sequence without loss or duplication',
    async () => {
      const result = record(
        await runTransportScenario({
          label: 'e) poll 250ms / pooled / recycle',
          producerConnectionString: directUrl,
          consumerConnectionString: pooledUrl,
          transport: 'poll-by-sequence',
          workflowId: await createSpikeWorkflow(admin, identifiers),
          segmentCount: recycleSegmentCount,
          segmentsPerSecond,
          pollIntervalMs: 250,
          recycleAfterSegments: Math.floor(recycleSegmentCount / 3),
          recycleDowntimeMs: 3_000,
        }),
      )
      expect(result.recycled).toBe(true)
      expect(result.missingCount).toBe(0)
      expect(result.duplicateCount).toBe(0)
      expect(result.latency.meetsSc002).toBe(true)
    },
    scenarioTimeoutMs,
  )

  it(
    '(f) recycle mid-stream: LISTEN/NOTIFY with a sequence backfill on reconnect',
    async () => {
      const result = record(
        await runTransportScenario({
          label: 'f) listen-notify / direct / recycle + backfill',
          producerConnectionString: directUrl,
          consumerConnectionString: directUrl,
          transport: 'listen-notify',
          workflowId: await createSpikeWorkflow(admin, identifiers),
          segmentCount: recycleSegmentCount,
          segmentsPerSecond,
          backfillOnConnect: true,
          recycleAfterSegments: Math.floor(recycleSegmentCount / 3),
          recycleDowntimeMs: 3_000,
        }),
      )
      expect(result.recycled).toBe(true)
      expect(result.missingCount).toBe(0)
      expect(result.duplicateCount).toBe(0)
    },
    scenarioTimeoutMs,
  )

  it(
    '(g) recycle mid-stream: LISTEN/NOTIFY with no backfill loses the downtime window',
    async () => {
      const result = record(
        await runTransportScenario({
          label: 'g) listen-notify / direct / recycle, no backfill',
          producerConnectionString: directUrl,
          consumerConnectionString: directUrl,
          transport: 'listen-notify',
          workflowId: await createSpikeWorkflow(admin, identifiers),
          segmentCount: recycleSegmentCount,
          segmentsPerSecond,
          backfillOnConnect: false,
          recycleAfterSegments: Math.floor(recycleSegmentCount / 3),
          recycleDowntimeMs: 3_000,
        }),
      )
      // The control: notifications emitted while nothing is listening are gone for good. This is
      // the reason the reconnect path must be a sequence read, not a re-LISTEN.
      expect(result.recycled).toBe(true)
      expect(result.missingCount).toBeGreaterThan(0)
      expect(result.duplicateCount).toBe(0)
    },
    scenarioTimeoutMs,
  )
})
