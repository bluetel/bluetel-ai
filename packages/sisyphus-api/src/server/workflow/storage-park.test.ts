import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { workflowEvents, workflows } from '../../db'
import { snapshotParkDetailFor } from '../machine'

import { readWorkflowDetail } from './queries'
import { isWaitingOnStorage, readStoragePark } from './storage-park'
import type { TwoProfileFixture } from './test-support'
import { createTwoProfileFixture, readTestDatabaseUrl } from './test-support'

/**
 * The read half of a snapshot park (T184, FR-082).
 *
 * `machine.reportSnapshotPark` appends one timeline entry per failed attempt. The question the
 * panel actually asks is different — "is this run waiting on storage **now**, and how many tries
 * has it had" — and this is where that is answered. Two things are worth proving beyond the happy
 * path: that a park stops reading as current once the snapshot lands, and that the terminal
 * `parked` entry `reportTerminal` writes for a `parked_resumable` outcome is **not** mistaken for
 * one of these, because it means the opposite.
 */

const connectionString = readTestDatabaseUrl()

const AT = (iso: string): Date => new Date(iso)

describe('isWaitingOnStorage', () => {
  const parkedAt = AT('2026-08-06T12:00:00Z')

  it('is waiting when nothing has been snapshotted since the park', () => {
    expect(isWaitingOnStorage({ parkedAt, snapshotRegisteredAt: null, state: 'running' })).toBe(
      true,
    )
  })

  it('is waiting when the last snapshot predates the park', () => {
    expect(
      isWaitingOnStorage({
        parkedAt,
        snapshotRegisteredAt: AT('2026-08-06T11:59:00Z'),
        state: 'running',
      }),
    ).toBe(true)
  })

  it('is not waiting once a snapshot lands after the park — that is the retry succeeding', () => {
    expect(
      isWaitingOnStorage({
        parkedAt,
        snapshotRegisteredAt: AT('2026-08-06T12:00:30Z'),
        state: 'running',
      }),
    ).toBe(false)
  })

  it('resolves a same-instant tie in favour of the snapshot having landed', () => {
    // Claiming a run is stuck when its work is safe is the worse of the two errors.
    expect(isWaitingOnStorage({ parkedAt, snapshotRegisteredAt: parkedAt, state: 'running' })).toBe(
      false,
    )
  })

  it('is not waiting once the run has ended, however the park left off', () => {
    // Including the case the park itself caused: the budget ran out, `reportTerminal` recorded
    // `failed` naming the boundary, and there is nothing left to wait for.
    for (const state of [
      'failed',
      'succeeded',
      'capped',
      'cancelled',
      'parked_resumable',
    ] as const) {
      expect(isWaitingOnStorage({ parkedAt, snapshotRegisteredAt: null, state })).toBe(false)
    }
  })
})

describe.skipIf(connectionString === undefined)('readStoragePark', () => {
  let fixture: TwoProfileFixture

  beforeAll(async () => {
    fixture = createTwoProfileFixture(connectionString ?? '')
    await fixture.open()
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  const runA = () => ({ id: fixture.ids().a.workflowId, state: 'running' as const })

  const park = async (attempt: number) => {
    await fixture
      .db()
      .insert(workflowEvents)
      .values({
        workflowId: fixture.ids().a.workflowId,
        event: 'parked',
        actorType: 'executor',
        detail: snapshotParkDetailFor({
          boundary: 'pause',
          attempt,
          maxAttempts: 8,
          nextDelayMs: 1000,
          detail: 'the snapshot bucket is unreachable',
        }),
      })
  }

  it('answers null for a run that has never parked', async () => {
    expect(await readStoragePark(fixture.db(), runA())).toBeNull()
  })

  it('reads back the latest attempt, waiting (FR-082)', async () => {
    await park(1)
    await park(2)

    expect(await readStoragePark(fixture.db(), runA())).toMatchObject({
      boundary: 'pause',
      attempt: 2,
      maxAttempts: 8,
      detail: 'the snapshot bucket is unreachable',
      waiting: true,
    })
  })

  it('stops reading as waiting once the snapshot is registered', async () => {
    await fixture
      .db()
      .insert(workflowEvents)
      .values({
        workflowId: fixture.ids().a.workflowId,
        event: 'snapshot_registered',
        actorType: 'executor',
        detail: { boundary: 'pause' },
      })

    const park = await readStoragePark(fixture.db(), runA())

    // The row is still returned. "This run parked and then recovered" is a fact about the run, and
    // it is the explanation for a gap in the log.
    expect(park).toMatchObject({ attempt: 2, waiting: false })
  })

  it('ignores the terminal `parked` entry, which means the opposite thing', async () => {
    const b = { id: fixture.ids().b.workflowId, state: 'parked_resumable' as const }

    await fixture
      .db()
      .insert(workflowEvents)
      .values({
        workflowId: b.id,
        event: 'parked',
        actorType: 'executor',
        // The shape `reportTerminal` writes: no `waitingOn`, because this run's snapshot landed and
        // its compute was released.
        detail: { reason: 'reclaimed mid-run', turnsUsed: 3, spendUsed: '1.0000' },
      })

    expect(await readStoragePark(fixture.db(), b)).toBeNull()
  })

  it('reads a detail it cannot parse as no park on record, not as a half-filled card', async () => {
    const b = fixture.ids().b.workflowId

    await fixture
      .db()
      .insert(workflowEvents)
      .values({
        workflowId: b,
        event: 'parked',
        actorType: 'executor',
        detail: { waitingOn: 'storage', boundary: 'pause' },
      })

    expect(await readStoragePark(fixture.db(), { id: b, state: 'running' })).toBeNull()

    await fixture.db().delete(workflowEvents).where(eq(workflowEvents.workflowId, b))
  })

  it('rides on the detail read the panel already makes (FR-014)', async () => {
    const scope = await fixture.scopeFor(fixture.ids().alice)
    const detail = await readWorkflowDetail({
      db: fixture.db(),
      scope,
      workflowId: fixture.ids().a.workflowId,
    })

    expect(detail.storagePark).toMatchObject({ attempt: 2, boundary: 'pause' })
  })

  it('reports a park on a finished run as no longer waiting', async () => {
    await fixture
      .db()
      .update(workflows)
      .set({ state: 'failed', terminalOutcome: 'failed' })
      .where(eq(workflows.id, fixture.ids().a.workflowId))

    const scope = await fixture.scopeFor(fixture.ids().alice)
    const detail = await readWorkflowDetail({
      db: fixture.db(),
      scope,
      workflowId: fixture.ids().a.workflowId,
    })

    expect(detail.storagePark?.waiting).toBe(false)
  })
})
