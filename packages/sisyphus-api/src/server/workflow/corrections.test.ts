import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { corrections, workflowEvents } from '../../db'
import { createCallerFactory, createTRPCRouter } from '../procedures'

import {
  acknowledgeCorrection,
  correctionsProcedure,
  correctProcedure,
  pullPendingCorrections,
  readCorrectionsInScope,
  submitCorrection,
} from './corrections'
import { createSupervisionFixture, readTestDatabaseUrl } from './supervision-fixtures'

/**
 * T093, the API half — exactly once, in submission order, never silently dropped.
 *
 * Three assertions carry the requirement and the rest is mechanism:
 *
 * - two corrections submitted in order come back to the executor as 1 then 2;
 * - a delivered correction is never returned by a later pull, however many times it is acknowledged;
 * - a failed delivery is **visible**, with its reason, in the read the panel renders.
 */

const correctionsRouter = createTRPCRouter({
  correct: correctProcedure,
  corrections: correctionsProcedure,
})

const createCaller = createCallerFactory(correctionsRouter)

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

describeWithDatabase('the corrections queue against a live database', () => {
  const fixture = createSupervisionFixture(connectionString ?? '')

  beforeAll(() => fixture.open(), 60_000)
  afterEach(() => fixture.clean())
  afterAll(() => fixture.close())

  it('queues a correction and hands it to the executor', async () => {
    const owner = await fixture.seedUser('correct-owner')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'running' })
    const scope = await fixture.scopeFor(owner.id)

    const queued = await submitCorrection({
      db: fixture.db(),
      scope,
      userId: owner.id,
      input: { workflowId, body: 'use the existing helper rather than adding one' },
    })

    expect(queued).toMatchObject({ applied: true, sequence: 1 })

    const pending = await pullPendingCorrections(fixture.machineContextFor(workflowId))
    expect(pending.map((row) => row.body)).toStrictEqual([
      'use the existing helper rather than adding one',
    ])
  })

  it('delivers in submission order, not in whatever order the plan produced', async () => {
    const owner = await fixture.seedUser('order-owner')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'running' })
    const scope = await fixture.scopeFor(owner.id)
    const submit = (body: string) =>
      submitCorrection({ db: fixture.db(), scope, userId: owner.id, input: { workflowId, body } })

    await submit('first')
    await submit('second')
    await submit('third')

    const pending = await pullPendingCorrections(fixture.machineContextFor(workflowId))
    expect(pending.map((row) => [row.sequence, row.body])).toStrictEqual([
      [1, 'first'],
      [2, 'second'],
      [3, 'third'],
    ])
  })

  it('gives two concurrent submissions distinct sequences, so neither loses on the index', async () => {
    const owner = await fixture.seedUser('concurrent-owner')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'running' })
    const scope = await fixture.scopeFor(owner.id)

    const results = await Promise.all([
      submitCorrection({
        db: fixture.db(),
        scope,
        userId: owner.id,
        input: { workflowId, body: 'racing one' },
      }),
      submitCorrection({
        db: fixture.db(),
        scope,
        userId: owner.id,
        input: { workflowId, body: 'racing two' },
      }),
    ])

    const sequences = results.flatMap((result) => (result.applied ? [result.sequence] : []))
    expect([...sequences].sort()).toStrictEqual([1, 2])
  }, 30_000)

  it('delivers each correction exactly once: a delivered row never comes back', async () => {
    const owner = await fixture.seedUser('once-owner')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'running' })
    const scope = await fixture.scopeFor(owner.id)
    const machine = fixture.machineContextFor(workflowId)

    const queued = await submitCorrection({
      db: fixture.db(),
      scope,
      userId: owner.id,
      input: { workflowId, body: 'only once' },
    })
    const correctionId = queued.applied ? queued.correctionId : ''

    const first = await acknowledgeCorrection(machine, { correctionId, outcome: 'delivered' })
    expect(first.recorded).toBe(true)
    expect(await pullPendingCorrections(machine)).toStrictEqual([])

    // The retry an executor cannot avoid: it cannot tell a lost response from a failed write.
    const second = await acknowledgeCorrection(machine, { correctionId, outcome: 'delivered' })
    expect(second.recorded).toBe(false)

    const events = await fixture
      .db()
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowId, workflowId))
    expect(events.map((event) => event.event)).toStrictEqual(['corrected'])
  })

  it('cannot be re-delivered by an acknowledgement that arrives after a failure', async () => {
    // `failed` also takes the row out of `pending`, so a delivery that failed does not silently
    // become a delivery that succeeds on the next poll.
    const owner = await fixture.seedUser('failed-once-owner')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'running' })
    const scope = await fixture.scopeFor(owner.id)
    const machine = fixture.machineContextFor(workflowId)

    const queued = await submitCorrection({
      db: fixture.db(),
      scope,
      userId: owner.id,
      input: { workflowId, body: 'undeliverable' },
    })
    const correctionId = queued.applied ? queued.correctionId : ''

    await acknowledgeCorrection(machine, {
      correctionId,
      outcome: 'failed',
      failureReason: 'the agent session ended before the turn was acknowledged',
    })

    expect(await pullPendingCorrections(machine)).toStrictEqual([])
    await expect(
      acknowledgeCorrection(machine, { correctionId, outcome: 'delivered' }),
    ).resolves.toMatchObject({ recorded: false })
  })

  it('makes a failed delivery visible to the user, with its reason (FR-049)', async () => {
    const owner = await fixture.seedUser('visible-owner')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'running' })
    const scope = await fixture.scopeFor(owner.id)
    const machine = fixture.machineContextFor(workflowId)

    const queued = await submitCorrection({
      db: fixture.db(),
      scope,
      userId: owner.id,
      input: { workflowId, body: 'this one will not land' },
    })
    await acknowledgeCorrection(machine, {
      correctionId: queued.applied ? queued.correctionId : '',
      outcome: 'failed',
      failureReason: 'the agent process is not accepting input',
    })

    const visible = await readCorrectionsInScope({ db: fixture.db(), scope, workflowId })

    expect(visible).toHaveLength(1)
    expect(visible[0]).toMatchObject({
      body: 'this one will not land',
      deliveryOutcome: 'failed',
      failureReason: 'the agent process is not accepting input',
      deliveredAt: null,
    })
  })

  it('never lets one workflow acknowledge another workflow’s correction', async () => {
    const owner = await fixture.seedUser('cross-owner')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'running' })
    const otherWorkflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'running' })
    const scope = await fixture.scopeFor(owner.id)

    const queued = await submitCorrection({
      db: fixture.db(),
      scope,
      userId: owner.id,
      input: { workflowId, body: 'mine' },
    })

    await expect(
      acknowledgeCorrection(fixture.machineContextFor(otherWorkflowId), {
        correctionId: queued.applied ? queued.correctionId : '',
        outcome: 'delivered',
      }),
    ).resolves.toMatchObject({ recorded: false })

    expect(await pullPendingCorrections(fixture.machineContextFor(workflowId))).toHaveLength(1)
  })

  it('refuses a correction against a finished run with an explanation (T096, FR-081)', async () => {
    const owner = await fixture.seedUser('terminal-correct-owner')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'cancelled' })
    const scope = await fixture.scopeFor(owner.id)

    const result = await submitCorrection({
      db: fixture.db(),
      scope,
      userId: owner.id,
      input: { workflowId, body: 'too late' },
    })

    expect(result).toMatchObject({
      applied: false,
      alreadyFinished: true,
      code: 'E_WORKFLOW_ALREADY_FINISHED',
    })
    expect(result.applied ? '' : result.explanation).toContain('correction')
  })

  it('records the refused correction rather than discarding the text (FR-081)', async () => {
    const owner = await fixture.seedUser('recorded-correct-owner')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'succeeded' })
    const scope = await fixture.scopeFor(owner.id)

    await submitCorrection({
      db: fixture.db(),
      scope,
      userId: owner.id,
      input: { workflowId, body: 'written after it finished' },
    })

    const rows = await fixture
      .db()
      .select()
      .from(corrections)
      .where(eq(corrections.workflowId, workflowId))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      body: 'written after it finished',
      deliveryOutcome: 'rejected',
      workflowStateAtSubmission: 'succeeded',
    })

    // And the executor never sees it.
    expect(await pullPendingCorrections(fixture.machineContextFor(workflowId))).toStrictEqual([])
  })

  it('records what the run was doing when the text was written', async () => {
    const owner = await fixture.seedUser('state-at-owner')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'paused' })
    const scope = await fixture.scopeFor(owner.id)

    await submitCorrection({
      db: fixture.db(),
      scope,
      userId: owner.id,
      input: { workflowId, body: 'while paused' },
    })

    const rows = await fixture
      .db()
      .select()
      .from(corrections)
      .where(eq(corrections.workflowId, workflowId))
    expect(rows[0]?.workflowStateAtSubmission).toBe('paused')
  })

  it('answers NOT_FOUND for a run outside the caller’s scope, never FORBIDDEN (FR-190)', async () => {
    const owner = await fixture.seedUser('correct-scope-owner')
    const stranger = await fixture.seedUser('correct-stranger')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'running' })

    const caller = createCaller(await fixture.contextFor(stranger))

    await expect(caller.correct({ workflowId, body: 'not mine' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(caller.corrections({ workflowId })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const rows = await fixture
      .db()
      .select()
      .from(corrections)
      .where(eq(corrections.workflowId, workflowId))
    expect(rows).toStrictEqual([])
  })

  it('lets the owner submit and read back through the procedures', async () => {
    const owner = await fixture.seedUser('correct-procedure-owner')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'running' })
    const caller = createCaller(await fixture.contextFor(owner))

    await caller.correct({ workflowId, body: 'prefer the existing module' })
    const visible = await caller.corrections({ workflowId })

    expect(visible.map((row) => row.body)).toStrictEqual(['prefer the existing module'])
    expect(visible[0]?.deliveryOutcome).toBe('pending')
  })
})
