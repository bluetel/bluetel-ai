import { beforeEach, describe, expect, it } from 'vitest'

import { sanitise } from './sanitise'
import type { LogSegmentRecord, SegmentReporter, SegmentStore } from './segments'
import { createSegmentWriter } from './segments'

/* cspell:ignore mtoken */

const ESC = String.fromCharCode(0x1b)
const WORKFLOW_ID = '00000000-0000-4000-8000-000000000001'

/** Synthetic. Not a credential belonging to anything. */
const AGENT_VALUE = 'not-a-real-agent-credential-0123456789'
const SECRETS = [{ name: 'agent-credential', value: AGENT_VALUE }]

interface Fakes {
  readonly store: SegmentStore
  readonly reporter: SegmentReporter
  readonly puts: { key: string; body: string }[]
  readonly reported: LogSegmentRecord[]
  readonly calls: string[]
  failReportsBefore: number
  failStoreBefore: number
}

const createFakes = (): Fakes => {
  const puts: { key: string; body: string }[] = []
  const reported: LogSegmentRecord[] = []
  const calls: string[] = []

  const fakes: Fakes = {
    puts,
    reported,
    calls,
    failReportsBefore: 0,
    failStoreBefore: 0,
    store: {
      put: async ({ key, body }) => {
        calls.push(`put:${key}`)
        puts.push({ key, body })

        if (puts.length <= fakes.failStoreBefore) {
          throw new Error('object storage unreachable')
        }

        await Promise.resolve()
      },
    },
    reporter: {
      appendLogSegment: async (record) => {
        calls.push(`report:${record.sequence}`)
        reported.push(record)

        if (reported.length <= fakes.failReportsBefore) {
          throw new Error('machine surface unreachable')
        }

        await Promise.resolve()
      },
    },
  }

  return fakes
}

const withClock = (): { advance: (ms: number) => void; now: () => number } => {
  let moment = 1_700_000_000_000

  return {
    advance: (ms: number) => {
      moment += ms
    },
    now: () => moment,
  }
}

describe('createSegmentWriter', () => {
  let fakes: Fakes

  beforeEach(() => {
    fakes = createFakes()
  })

  it('persists sanitised bodies, never the raw output', async () => {
    const writer = createSegmentWriter({
      workflowId: WORKFLOW_ID,
      store: fakes.store,
      reporter: fakes.reporter,
      secrets: SECRETS,
    })

    await writer.write(`${ESC}[31mtoken=${AGENT_VALUE}${ESC}[0m\n`)
    await writer.flush()

    expect(fakes.puts).toHaveLength(1)
    expect(fakes.puts[0].body).toBe('token=[redacted:agent-credential]\n')
    expect(fakes.puts[0].body).not.toContain(AGENT_VALUE)
    expect(fakes.puts[0].body).not.toContain(ESC)
  })

  it('sanitises before anything is stored, whatever the read boundaries are', async () => {
    const raw = `token=${AGENT_VALUE}\nplain line\n`

    for (let split = 1; split < raw.length; split += 1) {
      const local = createFakes()
      const writer = createSegmentWriter({
        workflowId: WORKFLOW_ID,
        store: local.store,
        reporter: local.reporter,
        secrets: SECRETS,
      })

      await writer.write(raw.slice(0, split))
      await writer.write(raw.slice(split))
      await writer.flush()

      expect(local.puts.map((put) => put.body).join('')).toBe(sanitise(raw, { secrets: SECRETS }))
    }
  })

  it('writes the object before reporting the row that points at it', async () => {
    const writer = createSegmentWriter({
      workflowId: WORKFLOW_ID,
      store: fakes.store,
      reporter: fakes.reporter,
    })

    await writer.write('one line\n')
    await writer.flush()

    expect(fakes.calls).toStrictEqual([`put:${fakes.puts[0].key}`, 'report:0'])
  })

  it('chunks a large run into several segments rather than dropping any of it', async () => {
    const writer = createSegmentWriter({
      workflowId: WORKFLOW_ID,
      store: fakes.store,
      reporter: fakes.reporter,
      maxSegmentBytes: 64,
    })
    const lines = Array.from({ length: 60 }, (_unused, line) => `line ${line}\n`).join('')

    await writer.write(lines)
    await writer.flush()

    expect(fakes.puts.length).toBeGreaterThan(5)
    expect(fakes.puts.map((put) => put.body).join('')).toBe(lines)
  })

  it('keeps every segment inside the size limit', async () => {
    const writer = createSegmentWriter({
      workflowId: WORKFLOW_ID,
      store: fakes.store,
      reporter: fakes.reporter,
      maxSegmentBytes: 64,
    })

    await writer.write(Array.from({ length: 60 }, (_unused, line) => `line ${line}\n`).join(''))
    await writer.flush()

    for (const record of fakes.reported) {
      expect(record.byteSize).toBeLessThanOrEqual(64)
    }
  })

  it('numbers segments monotonically from zero with no gaps', async () => {
    const writer = createSegmentWriter({
      workflowId: WORKFLOW_ID,
      store: fakes.store,
      reporter: fakes.reporter,
      maxSegmentBytes: 32,
    })

    await writer.write(Array.from({ length: 40 }, (_unused, line) => `line ${line}\n`).join(''))
    await writer.flush()

    expect(fakes.reported.map((record) => record.sequence)).toStrictEqual(
      fakes.reported.map((_unused, position) => position),
    )
  })

  it('continues a restored run from the sequence it was given', async () => {
    const writer = createSegmentWriter({
      workflowId: WORKFLOW_ID,
      store: fakes.store,
      reporter: fakes.reporter,
      startSequence: 42,
    })

    await writer.write('after restore\n')
    await writer.flush()

    expect(fakes.reported[0].sequence).toBe(42)
    expect(writer.nextSequence).toBe(43)
  })

  it('rate limits delivery without losing anything', async () => {
    const clock = withClock()
    const writer = createSegmentWriter({
      workflowId: WORKFLOW_ID,
      store: fakes.store,
      reporter: fakes.reporter,
      maxSegmentBytes: 16,
      segmentsPerSecond: 1,
      burstSegments: 1,
      now: clock.now,
    })
    const lines = Array.from({ length: 20 }, (_unused, line) => `line ${line}\n`).join('')

    await writer.write(lines)

    expect(fakes.reported.length).toBe(1)
    expect(writer.queuedSegments).toBeGreaterThan(0)

    clock.advance(3000)
    await writer.write('')

    expect(fakes.reported.length).toBeGreaterThan(1)

    await writer.flush()

    expect(writer.queuedSegments).toBe(0)
    expect(fakes.puts.map((put) => put.body).join('')).toBe(lines)
  })

  it('retries a failed report with the same sequence and key', async () => {
    fakes.failReportsBefore = 1

    const writer = createSegmentWriter({
      workflowId: WORKFLOW_ID,
      store: fakes.store,
      reporter: fakes.reporter,
      maxSegmentBytes: 16,
    })

    await writer.write(Array.from({ length: 10 }, (_unused, line) => `line ${line}\n`).join(''))

    expect(writer.queuedSegments).toBeGreaterThan(0)

    await writer.flush()

    expect(fakes.reported[1]).toStrictEqual(fakes.reported[0])
    expect(fakes.puts[1].key).toBe(fakes.puts[0].key)
    expect(writer.queuedSegments).toBe(0)
  })

  it('does not renumber later segments after an earlier one failed', async () => {
    fakes.failReportsBefore = 1

    const writer = createSegmentWriter({
      workflowId: WORKFLOW_ID,
      store: fakes.store,
      reporter: fakes.reporter,
      maxSegmentBytes: 16,
    })

    await writer.write(Array.from({ length: 10 }, (_unused, line) => `line ${line}\n`).join(''))
    await writer.flush()

    const delivered = fakes.reported.slice(1).map((record) => record.sequence)

    expect(delivered).toStrictEqual(delivered.map((_unused, position) => position))
  })

  it('does not let a transient reporting failure end the run', async () => {
    fakes.failReportsBefore = 1

    const writer = createSegmentWriter({
      workflowId: WORKFLOW_ID,
      store: fakes.store,
      reporter: fakes.reporter,
    })

    await expect(writer.write('a line\n')).resolves.toBeUndefined()
  })

  it('surfaces a failure on flush and keeps the segment queued', async () => {
    fakes.failReportsBefore = 10

    const writer = createSegmentWriter({
      workflowId: WORKFLOW_ID,
      store: fakes.store,
      reporter: fakes.reporter,
    })

    await writer.write('a line\n')
    await expect(writer.flush()).rejects.toThrow('machine surface unreachable')
    expect(writer.queuedSegments).toBe(1)
  })

  it('does not report a segment whose body never reached storage', async () => {
    fakes.failStoreBefore = 1

    const writer = createSegmentWriter({
      workflowId: WORKFLOW_ID,
      store: fakes.store,
      reporter: fakes.reporter,
      maxSegmentBytes: 16,
    })

    await writer.write(Array.from({ length: 10 }, (_unused, line) => `line ${line}\n`).join(''))

    expect(fakes.reported).toHaveLength(0)
    expect(fakes.puts).toHaveLength(1)

    await writer.flush()

    expect(fakes.reported.length).toBeGreaterThan(0)
  })

  it('writes nothing at all when there was no output', async () => {
    const writer = createSegmentWriter({
      workflowId: WORKFLOW_ID,
      store: fakes.store,
      reporter: fakes.reporter,
    })

    await writer.write('')
    await writer.flush()

    expect(fakes.puts).toStrictEqual([])
    expect(fakes.reported).toStrictEqual([])
  })

  it('partitions keys under the workflow', async () => {
    const writer = createSegmentWriter({
      workflowId: WORKFLOW_ID,
      store: fakes.store,
      reporter: fakes.reporter,
    })

    await writer.write('a line\n')
    await writer.flush()

    expect(fakes.puts[0].key.startsWith(`workflows/${WORKFLOW_ID}/logs/`)).toBe(true)
  })

  it('records the span from first output to segment cut', async () => {
    const clock = withClock()
    const start = clock.now()
    const writer = createSegmentWriter({
      workflowId: WORKFLOW_ID,
      store: fakes.store,
      reporter: fakes.reporter,
      now: clock.now,
    })

    await writer.write(Array.from({ length: 10 }, (_unused, line) => `line ${line}\n`).join(''))
    clock.advance(250)
    await writer.flush()

    const [record] = fakes.reported

    expect(record.startedAt.getTime()).toBe(start)
    expect(record.endedAt.getTime()).toBe(start + 250)
  })
})
