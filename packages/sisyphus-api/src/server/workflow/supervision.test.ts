import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { supervisionCommands, workflowEvents, workflows } from '../../db'
import { createCallerFactory, createTRPCRouter } from '../procedures'

import {
  acknowledgeSupervisionCommand,
  pauseProcedure,
  pullPendingSupervisionCommands,
  requestSupervisionCommand,
  resumeProcedure,
  stateAfterAcknowledgement,
  stopProcedure,
} from './supervision'
import { createSupervisionFixture, readTestDatabaseUrl } from './supervision-fixtures'

/**
 * T089 and T096 — the queue that makes the pause button work, and the refusal that makes pausing a
 * finished run a no-op with an explanation rather than an error.
 *
 * The assertion this file exists for is the negative one: **queueing a pause does not move the
 * workflow to `paused`.** Everything else here is mechanism; that is the requirement. A pause that
 * changed the state on request would have the panel claiming a pause while the agent was still
 * mid-turn, still spending and still writing to the working tree.
 */

/** A router built here rather than mounted, so the procedures are exercised as procedures. */
const supervisionRouter = createTRPCRouter({
  pause: pauseProcedure,
  resume: resumeProcedure,
  stop: stopProcedure,
})

const createCaller = createCallerFactory(supervisionRouter)

describe('stateAfterAcknowledgement — where "paused" becomes true', () => {
  it('moves to paused only when the executor acknowledged the pause', () => {
    expect(stateAfterAcknowledgement({ command: 'pause', outcome: 'acknowledged' })).toBe('paused')
    expect(stateAfterAcknowledgement({ command: 'pause', outcome: 'superseded' })).toBeNull()
    expect(stateAfterAcknowledgement({ command: 'pause', outcome: 'rejected' })).toBeNull()
  })

  it('moves back to running on an acknowledged resume', () => {
    expect(stateAfterAcknowledgement({ command: 'resume', outcome: 'acknowledged' })).toBe(
      'running',
    )
  })

  it('leaves stop to reportTerminal, so one run has one author for its one outcome', () => {
    expect(stateAfterAcknowledgement({ command: 'stop', outcome: 'acknowledged' })).toBeNull()
  })
})

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

describeWithDatabase('the supervision queue against a live database', () => {
  const fixture = createSupervisionFixture(connectionString ?? '')

  beforeAll(() => fixture.open(), 60_000)
  afterEach(() => fixture.clean())
  afterAll(() => fixture.close())

  const runningWorkflow = async (
    label: string,
  ): Promise<{ ownerId: string; email: string; workflowId: string }> => {
    const owner = await fixture.seedUser(label)
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'running' })

    return { ownerId: owner.id, email: owner.email, workflowId }
  }

  const stateOf = async (workflowId: string): Promise<string> => {
    const rows = await fixture
      .db()
      .select({ state: workflows.state })
      .from(workflows)
      .where(eq(workflows.id, workflowId))

    return rows[0]?.state ?? 'missing'
  }

  it('queues a pause without touching the workflow state (the whole point)', async () => {
    const { ownerId, workflowId } = await runningWorkflow('pause-owner')
    const scope = await fixture.scopeFor(ownerId)

    const result = await requestSupervisionCommand({
      db: fixture.db(),
      scope,
      userId: ownerId,
      workflowId,
      command: 'pause',
    })

    expect(result).toMatchObject({
      applied: true,
      command: 'pause',
      sequence: 1,
      outcome: 'pending',
    })
    expect(await stateOf(workflowId)).toBe('running')
  })

  it('is the row the executor reads: pull returns it in sequence order', async () => {
    const { ownerId, workflowId } = await runningWorkflow('pull-owner')
    const scope = await fixture.scopeFor(ownerId)
    const request = (command: 'pause' | 'resume' | 'stop') =>
      requestSupervisionCommand({ db: fixture.db(), scope, userId: ownerId, workflowId, command })

    await request('pause')
    await request('resume')

    const pending = await pullPendingSupervisionCommands(fixture.machineContextFor(workflowId))

    expect(pending.map((row) => [row.sequence, row.command, row.deliveryOutcome])).toStrictEqual([
      [1, 'pause', 'superseded'],
      [2, 'resume', 'pending'],
    ])
  })

  it('returns a superseded pause to the executor rather than hiding it', async () => {
    // Hiding it would leave the row uncollected forever, which is a queue that never drains.
    const { ownerId, workflowId } = await runningWorkflow('supersede-owner')
    const scope = await fixture.scopeFor(ownerId)

    await requestSupervisionCommand({
      db: fixture.db(),
      scope,
      userId: ownerId,
      workflowId,
      command: 'pause',
    })
    await requestSupervisionCommand({
      db: fixture.db(),
      scope,
      userId: ownerId,
      workflowId,
      command: 'stop',
    })

    const pending = await pullPendingSupervisionCommands(fixture.machineContextFor(workflowId))
    const pause = pending.find((row) => row.command === 'pause')

    expect(pause?.deliveryOutcome).toBe('superseded')
    expect(pause?.failureReason).toContain('overtaken by a stop')
    expect(pending.find((row) => row.command === 'stop')?.deliveryOutcome).toBe('pending')
  })

  it('makes the run paused only on the acknowledgement, and writes the timeline entry then', async () => {
    const { ownerId, workflowId } = await runningWorkflow('ack-owner')
    const scope = await fixture.scopeFor(ownerId)
    const machine = fixture.machineContextFor(workflowId)

    const queued = await requestSupervisionCommand({
      db: fixture.db(),
      scope,
      userId: ownerId,
      workflowId,
      command: 'pause',
    })
    expect(queued.applied).toBe(true)
    expect(await stateOf(workflowId)).toBe('running')

    const commandId = queued.applied ? queued.commandId : ''
    const acknowledgement = await acknowledgeSupervisionCommand(machine, {
      commandId,
      outcome: 'acknowledged',
    })

    expect(acknowledgement).toMatchObject({ recorded: true, workflowState: 'paused' })
    expect(await stateOf(workflowId)).toBe('paused')

    const events = await fixture
      .db()
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowId, workflowId))
    expect(events.map((event) => event.event)).toStrictEqual(['paused'])
  })

  it('treats a retried acknowledgement as an ordinary answer, not an error (FR-047)', async () => {
    const { ownerId, workflowId } = await runningWorkflow('retry-owner')
    const scope = await fixture.scopeFor(ownerId)
    const machine = fixture.machineContextFor(workflowId)

    const queued = await requestSupervisionCommand({
      db: fixture.db(),
      scope,
      userId: ownerId,
      workflowId,
      command: 'pause',
    })
    const commandId = queued.applied ? queued.commandId : ''

    await acknowledgeSupervisionCommand(machine, { commandId, outcome: 'acknowledged' })
    const second = await acknowledgeSupervisionCommand(machine, {
      commandId,
      outcome: 'acknowledged',
    })

    expect(second.recorded).toBe(false)

    // Once, not once per retry — the timeline is a record, not a counter of network attempts.
    const events = await fixture
      .db()
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowId, workflowId))
    expect(events).toHaveLength(1)
  })

  it('drains the queue: an acknowledged command is not returned by the next pull', async () => {
    const { ownerId, workflowId } = await runningWorkflow('drain-owner')
    const scope = await fixture.scopeFor(ownerId)
    const machine = fixture.machineContextFor(workflowId)

    const queued = await requestSupervisionCommand({
      db: fixture.db(),
      scope,
      userId: ownerId,
      workflowId,
      command: 'pause',
    })
    await acknowledgeSupervisionCommand(machine, {
      commandId: queued.applied ? queued.commandId : '',
      outcome: 'acknowledged',
    })

    expect(await pullPendingSupervisionCommands(machine)).toStrictEqual([])
  })

  it('never lets one workflow acknowledge another workflow’s command', async () => {
    const { ownerId, workflowId } = await runningWorkflow('mine-owner')
    const otherWorkflowId = await fixture.seedWorkflow({ ownerUserId: ownerId, state: 'running' })
    const scope = await fixture.scopeFor(ownerId)

    const queued = await requestSupervisionCommand({
      db: fixture.db(),
      scope,
      userId: ownerId,
      workflowId,
      command: 'pause',
    })

    const acknowledgement = await acknowledgeSupervisionCommand(
      fixture.machineContextFor(otherWorkflowId),
      { commandId: queued.applied ? queued.commandId : '', outcome: 'acknowledged' },
    )

    expect(acknowledgement.recorded).toBe(false)
    expect(await stateOf(workflowId)).toBe('running')
  })

  it('refuses a pause against a finished run with an explanation, not an error (T096, FR-081)', async () => {
    const owner = await fixture.seedUser('finished-owner')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'succeeded' })
    const scope = await fixture.scopeFor(owner.id)

    const result = await requestSupervisionCommand({
      db: fixture.db(),
      scope,
      userId: owner.id,
      workflowId,
      command: 'pause',
    })

    expect(result).toMatchObject({
      applied: false,
      alreadyFinished: true,
      code: 'E_WORKFLOW_ALREADY_FINISHED',
      state: 'succeeded',
    })
  })

  it('records the refused request as requested-but-not-applied (FR-081)', async () => {
    const owner = await fixture.seedUser('recorded-owner')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'failed' })
    const scope = await fixture.scopeFor(owner.id)

    await requestSupervisionCommand({
      db: fixture.db(),
      scope,
      userId: owner.id,
      workflowId,
      command: 'stop',
    })

    const rows = await fixture
      .db()
      .select()
      .from(supervisionCommands)
      .where(eq(supervisionCommands.workflowId, workflowId))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ command: 'stop', deliveryOutcome: 'rejected' })
    expect(rows[0]?.acknowledgedAt).not.toBeNull()

    // And it is inert: an executor polling this run collects nothing.
    expect(
      await pullPendingSupervisionCommands(fixture.machineContextFor(workflowId)),
    ).toStrictEqual([])
  })

  it('lets a parked run be resumed — the one exception to the terminal refusal (FR-151)', async () => {
    const owner = await fixture.seedUser('parked-owner')
    const workflowId = await fixture.seedWorkflow({
      ownerUserId: owner.id,
      state: 'parked_resumable',
    })
    const scope = await fixture.scopeFor(owner.id)

    await expect(
      requestSupervisionCommand({
        db: fixture.db(),
        scope,
        userId: owner.id,
        workflowId,
        command: 'resume',
      }),
    ).resolves.toMatchObject({ applied: true, command: 'resume' })

    await expect(
      requestSupervisionCommand({
        db: fixture.db(),
        scope,
        userId: owner.id,
        workflowId,
        command: 'pause',
      }),
    ).resolves.toMatchObject({ applied: false, alreadyFinished: true })
  })

  it('answers NOT_FOUND for a run outside the caller’s scope, never FORBIDDEN (FR-190)', async () => {
    const owner = await fixture.seedUser('scope-owner')
    const stranger = await fixture.seedUser('scope-stranger')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'running' })

    const caller = createCaller(await fixture.contextFor(stranger))

    await expect(caller.pause({ workflowId })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // And nothing was written, so a constraint violation cannot leak what the refusal withheld.
    const rows = await fixture
      .db()
      .select()
      .from(supervisionCommands)
      .where(eq(supervisionCommands.workflowId, workflowId))
    expect(rows).toStrictEqual([])
  })

  it('lets the owner drive all three procedures end to end', async () => {
    const owner = await fixture.seedUser('procedure-owner')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'running' })
    const caller = createCaller(await fixture.contextFor(owner))

    await expect(caller.pause({ workflowId })).resolves.toMatchObject({ command: 'pause' })
    await expect(caller.resume({ workflowId })).resolves.toMatchObject({ command: 'resume' })
    await expect(caller.stop({ workflowId })).resolves.toMatchObject({
      command: 'stop',
      outcome: 'pending',
    })

    const pending = await pullPendingSupervisionCommands(fixture.machineContextFor(workflowId))
    expect(pending.filter((row) => row.deliveryOutcome === 'pending')).toHaveLength(1)
  })
})
