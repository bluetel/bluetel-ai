import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { workflowEvents, workflows } from '../../db'
import { reportSnapshotParkInput, snapshotParkDetail } from '../../schemas'
import type { MachineCredential } from '../context'

import { reportSnapshotPark, snapshotParkDetailFor } from './snapshot-park'
import type { MachineFixture } from './test-support'
import { createMachineFixture, readTestDatabaseUrl } from './test-support'

/**
 * `machine.reportSnapshotPark` — the report that makes "waiting on storage" sayable (T184, FR-082).
 *
 * The property the suite is built around is the one that would be a serious defect to get wrong:
 * a storage park is a **live** run holding at a boundary, and `parked_resumable` is a **finished**
 * run whose snapshot landed and whose compute was released. They share a timeline event name and
 * they are near-opposites, so every test below checks the state the run is left in as well as the
 * row that was written.
 */

const connectionString = readTestDatabaseUrl()

describe('the snapshot-park payload', () => {
  it('rounds through the detail it records, so writer and reader cannot drift', () => {
    const input = reportSnapshotParkInput.parse({
      boundary: 'pause',
      attempt: 2,
      maxAttempts: 8,
      nextDelayMs: 2000,
      detail: 'connect ETIMEDOUT',
    })

    expect(snapshotParkDetail.parse(snapshotParkDetailFor(input))).toStrictEqual({
      waitingOn: 'storage',
      boundary: 'pause',
      attempt: 2,
      maxAttempts: 8,
      nextDelayMs: 2000,
      detail: 'connect ETIMEDOUT',
    })
  })

  it('records an explicit null when no explanation was given, rather than dropping the key', () => {
    expect(
      snapshotParkDetailFor(
        reportSnapshotParkInput.parse({
          boundary: 'stop',
          attempt: 1,
          maxAttempts: 8,
          nextDelayMs: 1000,
        }),
      ).detail,
    ).toBeNull()
  })
})

describe.skipIf(connectionString === undefined)('reportSnapshotPark', () => {
  let fixture: MachineFixture
  let credential: MachineCredential

  beforeAll(async () => {
    fixture = createMachineFixture(connectionString ?? '')
    await fixture.open()
    credential = await fixture.seedCredential(fixture.ids().a.workflowId)
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  const parkEvents = async (workflowId: string) =>
    fixture
      .db()
      .select()
      .from(workflowEvents)
      .where(and(eq(workflowEvents.workflowId, workflowId), eq(workflowEvents.event, 'parked')))

  const stateOf = async (workflowId: string) => {
    const rows = await fixture
      .db()
      .select({ state: workflows.state, terminalOutcome: workflows.terminalOutcome })
      .from(workflows)
      .where(eq(workflows.id, workflowId))

    return rows[0]
  }

  it('records the boundary and the attempt against the run (FR-082)', async () => {
    const { ctx } = fixture.contextFor(credential)

    const report = await reportSnapshotPark(ctx, {
      boundary: 'pause',
      attempt: 1,
      maxAttempts: 8,
      nextDelayMs: 1000,
      detail: 'the snapshot bucket is unreachable',
    })

    expect(report.recorded).toBe(true)
    expect(report.event?.actorType).toBe('executor')
    expect(snapshotParkDetail.parse(report.event?.detail)).toMatchObject({
      waitingOn: 'storage',
      boundary: 'pause',
      attempt: 1,
      maxAttempts: 8,
    })
  })

  it('leaves the run live — a park is not the `parked_resumable` outcome', async () => {
    const { ctx } = fixture.contextFor(credential)
    const before = await stateOf(fixture.ids().a.workflowId)

    await reportSnapshotPark(ctx, {
      boundary: 'pause',
      attempt: 2,
      maxAttempts: 8,
      nextDelayMs: 2000,
    })

    const after = await stateOf(fixture.ids().a.workflowId)

    // The instance is alive and holding a quiesced agent. Recording `parked_resumable` here would
    // tell the reconciler the compute had been handed back while it had not, and would tell the
    // operator their work was snapshotted at the exact moment it was not.
    expect(after.state).toBe(before.state)
    expect(after.state).not.toBe('parked_resumable')
    expect(after.terminalOutcome).toBeNull()
  })

  it('appends every attempt rather than collapsing them — the series is the useful part', async () => {
    const attempts = (await parkEvents(fixture.ids().a.workflowId))
      .map((row) => snapshotParkDetail.safeParse(row.detail))
      .flatMap((parsed) => (parsed.success ? [parsed.data.attempt] : []))

    expect([...attempts].sort((left, right) => left - right)).toStrictEqual([1, 2])
  })

  it('writes nothing against the other run — every write is scoped to the credential (FR-018)', async () => {
    expect(await parkEvents(fixture.ids().b.workflowId)).toStrictEqual([])
  })

  it('answers a park reported after the run ended rather than refusing it', async () => {
    const other = await fixture.seedCredential(fixture.ids().b.workflowId)
    const { ctx } = fixture.contextFor(other)

    await fixture
      .db()
      .update(workflows)
      .set({ state: 'succeeded', terminalOutcome: 'succeeded' })
      .where(eq(workflows.id, fixture.ids().b.workflowId))

    // An instance can still be mid-retry when the reconciler's backstop writes an outcome. Making
    // that an error would have the executor reporting a failure about a report.
    const report = await reportSnapshotPark(ctx, {
      boundary: 'interruption',
      attempt: 1,
      maxAttempts: 8,
      nextDelayMs: 1000,
    })

    expect(report).toStrictEqual({ event: null, recorded: false })
    expect(await parkEvents(fixture.ids().b.workflowId)).toStrictEqual([])
  })
})
