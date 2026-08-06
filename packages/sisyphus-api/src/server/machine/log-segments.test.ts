import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { logSegments } from '../../db'
import type { MachineCredential } from '../context'

import { appendLogSegment } from './log-segments'
import type { MachineFixture } from './test-support'
import { createMachineFixture, readTestDatabaseUrl } from './test-support'

/**
 * `appendLogSegment` idempotence (T063).
 *
 * This is the property the executor's retry loop depends on. It buffers and retries with backoff
 * whenever the surface is unreachable (FR-047), and it cannot distinguish a write that failed from
 * a write whose response was lost — so it retries either way. A duplicate must therefore be a
 * **no-op**: not a second row, which would duplicate output in the panel's reconstructed log, and
 * not an error either, which would make a successful write look like a failure and leave the
 * executor retrying forever.
 *
 * The concurrent case is the one an application-level check cannot get right, so it is exercised
 * directly below: two flushes of the same buffered segment racing must produce one row, and the
 * loser must be told it succeeded.
 */

const connectionString = readTestDatabaseUrl()

describe.skipIf(connectionString === undefined)('appendLogSegment', () => {
  let fixture: MachineFixture
  let credential: MachineCredential
  let nextSequence = 100

  beforeAll(async () => {
    fixture = createMachineFixture(connectionString ?? '')
    await fixture.open()
    credential = await fixture.seedCredential(fixture.ids().a.workflowId)
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  const segmentInput = (sequence: number, s3Key = `logs/${sequence}.txt`) => ({
    sequence,
    s3Key,
    byteSize: 64,
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    endedAt: new Date('2026-01-01T00:00:05.000Z'),
  })

  const takeSequence = (): number => {
    nextSequence += 1
    return nextSequence
  }

  const rowsFor = async (sequence: number) =>
    fixture
      .db()
      .select()
      .from(logSegments)
      .where(
        and(
          eq(logSegments.workflowId, fixture.ids().a.workflowId),
          eq(logSegments.sequence, sequence),
        ),
      )

  it('records a new segment against the credential’s workflow', async () => {
    const sequence = takeSequence()
    const { ctx } = fixture.contextFor(credential)

    const result = await appendLogSegment(ctx, segmentInput(sequence))

    expect(result.created).toBe(true)
    // The workflow id written is the credential's; the payload has no field that could name one.
    expect(result.segment.workflowId).toBe(fixture.ids().a.workflowId)
    expect(result.segment.sequence).toBe(sequence)
  })

  it('treats a retry as a no-op rather than a second row', async () => {
    const sequence = takeSequence()
    const { ctx } = fixture.contextFor(credential)

    const first = await appendLogSegment(ctx, segmentInput(sequence))
    const retry = await appendLogSegment(ctx, segmentInput(sequence))

    expect(first.created).toBe(true)
    expect(retry.created).toBe(false)
    expect(retry.segment.id).toBe(first.segment.id)
    await expect(rowsFor(sequence)).resolves.toHaveLength(1)
  })

  it('answers a retry with success, not an error', async () => {
    const sequence = takeSequence()
    const { ctx } = fixture.contextFor(credential)

    await appendLogSegment(ctx, segmentInput(sequence))

    // An error here would make a landed write look like a failure, and the executor would never
    // stop retrying it.
    await expect(appendLogSegment(ctx, segmentInput(sequence))).resolves.toMatchObject({
      created: false,
    })
  })

  it('keeps the first write when a retry carries different bytes', async () => {
    const sequence = takeSequence()
    const { ctx } = fixture.contextFor(credential)

    const first = await appendLogSegment(ctx, segmentInput(sequence, 'logs/original.txt'))
    const retry = await appendLogSegment(ctx, segmentInput(sequence, 'logs/different.txt'))

    // Overwriting would rewrite the run's log after the fact and hide a bug on the instance.
    expect(retry.segment.s3Key).toBe('logs/original.txt')
    expect(retry.segment.id).toBe(first.segment.id)
  })

  it('produces one row when two flushes race', async () => {
    const sequence = takeSequence()
    const { ctx } = fixture.contextFor(credential)

    const [a, b] = await Promise.all([
      appendLogSegment(ctx, segmentInput(sequence)),
      appendLogSegment(ctx, segmentInput(sequence)),
    ])

    // The database decides, not the application: a check-then-insert would let both through.
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1)
    expect(a.segment.id).toBe(b.segment.id)
    await expect(rowsFor(sequence)).resolves.toHaveLength(1)
  })

  it('keeps distinct sequences apart', async () => {
    const first = takeSequence()
    const second = takeSequence()
    const { ctx } = fixture.contextFor(credential)

    await appendLogSegment(ctx, segmentInput(first))
    await appendLogSegment(ctx, segmentInput(second))

    await expect(rowsFor(first)).resolves.toHaveLength(1)
    await expect(rowsFor(second)).resolves.toHaveLength(1)
  })

  it('refuses a window that runs backwards', async () => {
    const { ctx } = fixture.contextFor(credential)

    await expect(
      appendLogSegment(ctx, {
        ...segmentInput(takeSequence()),
        startedAt: new Date('2026-01-01T00:00:05.000Z'),
        endedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('cannot be made to write against another workflow', async () => {
    // Two credentials, two runs, the same sequence number: the unique index is per workflow, so
    // both succeed and each row lands on its own run.
    const other = await fixture.seedCredential(fixture.ids().b.workflowId)
    const sequence = takeSequence()

    const mine = await appendLogSegment(fixture.contextFor(credential).ctx, segmentInput(sequence))
    const theirs = await appendLogSegment(fixture.contextFor(other).ctx, segmentInput(sequence))

    expect(mine.segment.workflowId).toBe(fixture.ids().a.workflowId)
    expect(theirs.segment.workflowId).toBe(fixture.ids().b.workflowId)
    expect(mine.created).toBe(true)
    expect(theirs.created).toBe(true)
  })
})
