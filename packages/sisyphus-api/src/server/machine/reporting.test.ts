import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootstrapPhases, computeLeases, workflowEvents, workflows } from '../../db'
import type { MachineCredential } from '../context'

import { heartbeat, reportBootstrapPhase, reportTerminal } from './reporting'
import type { MachineFixture } from './test-support'
import { createMachineFixture, readTestDatabaseUrl } from './test-support'

/**
 * Heartbeat, bootstrap phases and the terminal report (T063).
 *
 * Every one of these is written against `ctx.workflowId` — there is no path by which a payload
 * could name a different run except the `entryId` on `reportBootstrapPhase`, and that is checked
 * and recorded. What the rest of this file is about is **retry safety**: the executor retries all
 * of these under FR-047 and cannot tell a failed write from a lost response, so each has to
 * survive arriving twice, and out of order.
 */

const connectionString = readTestDatabaseUrl()

describe.skipIf(connectionString === undefined)('the executor’s progress reports', () => {
  let fixture: MachineFixture
  let credentialA: MachineCredential
  let credentialB: MachineCredential

  beforeAll(async () => {
    fixture = createMachineFixture(connectionString ?? '')
    await fixture.open()
    credentialA = await fixture.seedCredential(fixture.ids().a.workflowId)
    credentialB = await fixture.seedCredential(fixture.ids().b.workflowId)
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  /**
   * Read one workflow, typed honestly. `noUncheckedIndexedAccess` is off in this project, so
   * destructuring the first row would type it as present even when the run has gone.
   */
  const readWorkflow = async (workflowId: string) => {
    const rows = await fixture.db().select().from(workflows).where(eq(workflows.id, workflowId))
    return rows.at(0)
  }

  describe('heartbeat (FR-048)', () => {
    it('records state and consumption on the credential’s own run', async () => {
      const { ctx } = fixture.contextFor(credentialA)

      const acknowledgement = await heartbeat(ctx, {
        state: 'running',
        turnsUsed: 5,
        spendUsed: '12.5000',
      })

      expect(acknowledgement.accepted).toBe(true)
      const workflow = await readWorkflow(fixture.ids().a.workflowId)
      expect(workflow?.turnsUsed).toBe(5)
      expect(Number(workflow?.spendUsed)).toBeCloseTo(12.5, 4)
    })

    it('never walks consumption backwards when a retry arrives late', async () => {
      const { ctx } = fixture.contextFor(credentialA)

      await heartbeat(ctx, { state: 'running', turnsUsed: 9, spendUsed: '20.0000' })
      await heartbeat(ctx, { state: 'running', turnsUsed: 2, spendUsed: '1.0000' })

      // A recorded spend that could go down makes the FR-055 cap unenforceable from this side.
      const workflow = await readWorkflow(fixture.ids().a.workflowId)
      expect(workflow?.turnsUsed).toBe(9)
      expect(Number(workflow?.spendUsed)).toBeCloseTo(20, 4)
    })

    it('touches the live compute lease, which is what the reconciler reads (FR-039)', async () => {
      const workflowId = fixture.ids().a.workflowId
      await fixture
        .db()
        .insert(computeLeases)
        .values({ workflowId, instanceType: 'm7i.large', purchaseMode: 'spot' })
        .onConflictDoNothing()

      const { ctx } = fixture.contextFor(credentialA)
      await heartbeat(ctx, { state: 'running', turnsUsed: 9, spendUsed: '20.0000' })

      const leases = await fixture
        .db()
        .select()
        .from(computeLeases)
        .where(and(eq(computeLeases.workflowId, workflowId), isNull(computeLeases.releasedAt)))

      expect(leases.at(0)?.lastHeartbeatAt).toBeInstanceOf(Date)
    })

    it('refuses a terminal state, which only reportTerminal may set', async () => {
      const { ctx } = fixture.contextFor(credentialA)

      await expect(
        heartbeat(ctx, { state: 'succeeded', turnsUsed: 1, spendUsed: '0' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    })
  })

  describe('reportBootstrapPhase (FR-145, FR-146)', () => {
    it('records phases in order, numbering them per run', async () => {
      const { ctx } = fixture.contextFor(credentialA)

      const download = await reportBootstrapPhase(ctx, {
        phase: 'bundle_download',
        outcome: 'succeeded',
      })
      const verify = await reportBootstrapPhase(ctx, {
        phase: 'bundle_verify',
        outcome: 'succeeded',
      })

      expect(download.workflowId).toBe(fixture.ids().a.workflowId)
      expect(verify.sequence).toBeGreaterThan(download.sequence)
    })

    it('updates rather than duplicating when the same phase is reported twice', async () => {
      const { ctx } = fixture.contextFor(credentialA)

      const first = await reportBootstrapPhase(ctx, {
        phase: 'setup_script',
        outcome: 'failed',
        detail: 'exit 1',
      })
      const retry = await reportBootstrapPhase(ctx, {
        phase: 'setup_script',
        outcome: 'succeeded',
        detail: 'exit 0',
      })

      expect(retry.id).toBe(first.id)
      expect(retry.outcome).toBe('succeeded')

      const rows = await fixture
        .db()
        .select()
        .from(bootstrapPhases)
        .where(
          and(
            eq(bootstrapPhases.workflowId, fixture.ids().a.workflowId),
            eq(bootstrapPhases.phase, 'setup_script'),
          ),
        )
      expect(rows).toHaveLength(1)
    })

    it('keeps per-entry phases apart from the run-wide ones', async () => {
      const { ctx } = fixture.contextFor(credentialA)

      const runWide = await reportBootstrapPhase(ctx, {
        phase: 'entry_checkout',
        outcome: 'succeeded',
      })
      const perEntry = await reportBootstrapPhase(ctx, {
        phase: 'entry_checkout',
        entryId: fixture.ids().a.workflowEntryId,
        outcome: 'succeeded',
      })

      expect(perEntry.id).not.toBe(runWide.id)
      expect(perEntry.entryId).toBe(fixture.ids().a.workflowEntryId)
    })

    it('refuses an entry belonging to another workflow, and records it (FR-018)', async () => {
      const { ctx, denials } = fixture.contextFor(credentialA)

      await expect(
        reportBootstrapPhase(ctx, {
          phase: 'entry_checkout',
          entryId: fixture.ids().b.workflowEntryId,
          outcome: 'succeeded',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })

      expect(denials).toHaveLength(1)
      expect(denials[0]).toMatchObject({
        reason: 'cross_workflow_write',
        workflowId: fixture.ids().a.workflowId,
      })
    })

    it('writes nothing when the entry check refuses', async () => {
      const rows = await fixture
        .db()
        .select()
        .from(bootstrapPhases)
        .where(eq(bootstrapPhases.workflowId, fixture.ids().b.workflowId))

      expect(rows).toStrictEqual([])
    })
  })

  describe('reportTerminal (FR-056, FR-064)', () => {
    it('records the outcome, the reason and a matching timeline event', async () => {
      const { ctx } = fixture.contextFor(credentialB)

      const report = await reportTerminal(ctx, {
        outcome: 'succeeded',
        reason: 'Work complete.',
        turnsUsed: 4,
        spendUsed: '99.0000',
      })

      expect(report.recorded).toBe(true)
      expect(report.workflow.state).toBe('succeeded')
      expect(report.workflow.terminalOutcome).toBe('succeeded')
      expect(report.workflow.outcomeReason).toBe('Work complete.')

      const events = await fixture
        .db()
        .select()
        .from(workflowEvents)
        .where(eq(workflowEvents.workflowId, fixture.ids().b.workflowId))

      expect(events.map((event) => event.event)).toContain('succeeded')
    })

    it('keeps the first outcome when a retry arrives, and still answers successfully', async () => {
      const { ctx } = fixture.contextFor(credentialB)

      const retry = await reportTerminal(ctx, {
        outcome: 'failed',
        reason: 'A retry claiming something else.',
        turnsUsed: 4,
        spendUsed: '99.0000',
      })

      // FR-064 allows exactly one outcome in force; a second report is answered, not applied.
      expect(retry.recorded).toBe(false)
      expect(retry.workflow.terminalOutcome).toBe('succeeded')
      expect(retry.workflow.outcomeReason).toBe('Work complete.')
    })

    it('ignores a heartbeat once the run is terminal, rather than reviving it', async () => {
      const { ctx } = fixture.contextFor(credentialB)

      const acknowledgement = await heartbeat(ctx, {
        state: 'running',
        turnsUsed: 100,
        spendUsed: '999.0000',
      })

      expect(acknowledgement.accepted).toBe(false)
      expect(acknowledgement.state).toBe('succeeded')
      const workflow = await readWorkflow(fixture.ids().b.workflowId)
      expect(workflow?.state).toBe('succeeded')
    })

    it('maps parked_resumable onto the parked timeline event', async () => {
      const { ctx } = fixture.contextFor(credentialA)

      const report = await reportTerminal(ctx, {
        outcome: 'parked_resumable',
        reason: 'Waiting on storage.',
        turnsUsed: 9,
        spendUsed: '20.0000',
      })

      expect(report.recorded).toBe(true)
      const events = await fixture
        .db()
        .select()
        .from(workflowEvents)
        .where(eq(workflowEvents.workflowId, fixture.ids().a.workflowId))

      expect(events.map((event) => event.event)).toContain('parked')
    })
  })
})
