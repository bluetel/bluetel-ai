import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { DatabaseClient } from '../../db'
import { createDatabaseClient, supervisionCommands, workflows } from '../../db'
import { TERMINAL_WORKFLOW_STATES, WORKFLOW_STATES } from '../../enums'

import { requestSupervisionCommand } from './supervision'
import {
  createGate,
  createSupervisionFixture,
  readTestDatabaseUrl,
  waitForBlockedBackend,
} from './supervision-fixtures'
import {
  ALREADY_FINISHED_CODE,
  describeAlreadyFinished,
  isAlreadyFinishedFor,
  isTerminalState,
  lockWorkflowForTransition,
  nextCommandSequence,
  runWorkflowTransition,
} from './transition'

/**
 * T094 — row-level serialisation of supervision transitions.
 *
 * The live suite at the bottom is the one that matters. A sequential test of a locking read passes
 * just as happily with `for update` deleted, so the assertion that carries the requirement is that
 * a *second, concurrent* transaction genuinely parks on the lock — confirmed by asking Postgres
 * (`pg_stat_activity.wait_event_type = 'Lock'`) rather than by inferring it from timing.
 */

describe('the locking read, as SQL', () => {
  let client: DatabaseClient

  beforeAll(() => {
    client = createDatabaseClient({ connectionString: 'postgres://compile-only@127.0.0.1:1/none' })
  })

  afterAll(async () => {
    await client.close()
  })

  it('takes the workflow row with `for update`, not with a plain read', () => {
    const compiled = client.db
      .select()
      .from(workflows)
      .where(eq(workflows.id, 'x'))
      .for('update')
      .toSQL().sql

    expect(compiled).toMatch(/for update/i)
  })
})

describe('isTerminalState', () => {
  it('is exactly the FR-064 outcome set, derived rather than restated', () => {
    expect([...WORKFLOW_STATES.filter(isTerminalState)].sort()).toStrictEqual(
      [...TERMINAL_WORKFLOW_STATES].sort(),
    )
  })
})

describe('isAlreadyFinishedFor (FR-081, FR-151)', () => {
  it('refuses every request against a run that finished', () => {
    for (const intent of ['pause', 'resume', 'stop', 'correction'] as const) {
      expect(isAlreadyFinishedFor('succeeded', intent)).toBe(true)
      expect(isAlreadyFinishedFor('failed', intent)).toBe(true)
      expect(isAlreadyFinishedFor('cancelled', intent)).toBe(true)
    }
  })

  it('permits nothing at all against a live run', () => {
    for (const intent of ['pause', 'resume', 'stop', 'correction'] as const) {
      expect(isAlreadyFinishedFor('running', intent)).toBe(false)
      expect(isAlreadyFinishedFor('paused', intent)).toBe(false)
    }
  })

  it('lets a parked run be resumed and nothing else — the single named exception (FR-151)', () => {
    expect(isAlreadyFinishedFor('parked_resumable', 'resume')).toBe(false)
    expect(isAlreadyFinishedFor('parked_resumable', 'pause')).toBe(true)
    expect(isAlreadyFinishedFor('parked_resumable', 'stop')).toBe(true)
    expect(isAlreadyFinishedFor('parked_resumable', 'correction')).toBe(true)
  })
})

describe('describeAlreadyFinished (T096, FR-081)', () => {
  const locked = {
    id: '0199a1f4-0000-7000-8000-0000000000ab',
    state: 'capped' as const,
    terminalOutcome: 'capped' as const,
    outcomeReason: 'turn cap of 40 reached',
    recordedAt: new Date('2026-08-05T09:00:00.000Z'),
  }

  it('is a response, not an error — the request was answered, not rejected as malformed', () => {
    const refusal = describeAlreadyFinished(locked, 'pause')

    expect(refusal.applied).toBe(false)
    expect(refusal.alreadyFinished).toBe(true)
    expect(refusal.code).toBe(ALREADY_FINISHED_CODE)
  })

  it('names the outcome and the recorded reason, so the operator needs no second click', () => {
    const refusal = describeAlreadyFinished(locked, 'pause')

    expect(refusal.explanation).toContain('stopped at its turn or spend cap')
    expect(refusal.explanation).toContain('turn cap of 40 reached')
    expect(refusal.explanation).toContain('pause')
  })

  it('says which request was not applied', () => {
    expect(describeAlreadyFinished(locked, 'correction').explanation).toContain('correction')
    expect(describeAlreadyFinished(locked, 'stop').explanation).toContain('stop')
  })

  it('copes with a terminal state that has no recorded outcome row', () => {
    const refusal = describeAlreadyFinished(
      { ...locked, terminalOutcome: null, outcomeReason: null },
      'pause',
    )

    expect(refusal.explanation).toContain('stopped at its turn or spend cap')
    expect(refusal.explanation).not.toContain('Recorded reason')
  })
})

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

describeWithDatabase('supervision transitions against a live database', () => {
  const fixture = createSupervisionFixture(connectionString ?? '')

  beforeAll(() => fixture.open(), 60_000)
  afterEach(() => fixture.clean())
  afterAll(() => fixture.close())

  it('allocates consecutive sequences under the lock', async () => {
    const owner = await fixture.seedUser('sequence-owner')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'running' })

    const first = await runWorkflowTransition({
      db: fixture.db(),
      workflowId,
      apply: ({ writer }) => nextCommandSequence(writer, workflowId),
    })
    expect(first).toBe(1)

    await fixture.db().insert(supervisionCommands).values({
      workflowId,
      command: 'pause',
      requestedByUserId: owner.id,
      sequence: first,
    })

    const second = await runWorkflowTransition({
      db: fixture.db(),
      workflowId,
      apply: ({ writer }) => nextCommandSequence(writer, workflowId),
    })
    expect(second).toBe(2)
  })

  it('reads the state as locked, and reports a vanished run as absent', async () => {
    const owner = await fixture.seedUser('locked-state')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'running' })

    const locked = await runWorkflowTransition({
      db: fixture.db(),
      workflowId,
      apply: ({ locked: state }) => Promise.resolve(state),
    })
    expect(locked).toMatchObject({ id: workflowId, state: 'running' })

    await expect(
      runWorkflowTransition({
        db: fixture.db(),
        workflowId: crypto.randomUUID(),
        apply: () => Promise.resolve('unreachable'),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  /**
   * **The test T094 exists for.**
   *
   * A `stop` and a `pause` are issued against the same run at the same moment. The winner is held
   * open after it has written, so its row lock is still in place when the loser arrives; the loser
   * is then confirmed to be *parked on a lock* by Postgres before the winner is released. Without
   * that confirmation a run in which the loser simply happened to execute second would look
   * identical to one in which the lock made it wait, and only the second proves anything.
   *
   * The outcome is the requirement: the pause wakes up seeing the committed stop, and is written
   * `superseded` rather than joining it as a second live command.
   */
  it('makes a concurrent pause block on the stop, and then lose to it', async () => {
    const owner = await fixture.seedUser('race-owner')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'running' })
    const scope = await fixture.scopeFor(owner.id)

    const written = createGate()
    const release = createGate()

    // The winner: a real transition, held open after writing so the row lock survives the wait.
    const winner = fixture.db().transaction(async (writer) => {
      await writer.select().from(workflows).where(eq(workflows.id, workflowId)).for('update')
      await writer.insert(supervisionCommands).values({
        workflowId,
        command: 'stop',
        requestedByUserId: owner.id,
        sequence: 1,
      })
      written.open()
      await release.opened

      return 'stopped'
    })

    await written.opened

    let loserSettled = false
    const loser = requestSupervisionCommand({
      db: fixture.db(),
      scope,
      userId: owner.id,
      workflowId,
      command: 'pause',
    }).finally(() => {
      loserSettled = true
    })

    const blocked = await waitForBlockedBackend(fixture)
    expect(blocked).toBeGreaterThan(0)
    expect(loserSettled).toBe(false)

    release.open()
    await expect(winner).resolves.toBe('stopped')

    // The locking read woke on the *committed* stop, saw it uncollected, and superseded itself.
    // A non-locking read would have seen an empty queue and written a second live command.
    const outcome = await loser
    expect(outcome).toMatchObject({ applied: true, outcome: 'superseded', sequence: 2 })

    const rows = await fixture
      .db()
      .select()
      .from(supervisionCommands)
      .where(eq(supervisionCommands.workflowId, workflowId))

    expect(rows.filter((row) => row.deliveryOutcome === 'pending')).toHaveLength(1)
    expect(rows.find((row) => row.command === 'pause')?.deliveryOutcome).toBe('superseded')
  }, 30_000)

  it('lets exactly one of two simultaneous pauses take sequence 1', async () => {
    // The same race without the choreography: fire both and let the database decide. Under a
    // non-locking `max(sequence) + 1` both would compute 1 and one would die on the unique index.
    const owner = await fixture.seedUser('both-owner')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'running' })
    const scope = await fixture.scopeFor(owner.id)

    const results = await Promise.all([
      requestSupervisionCommand({
        db: fixture.db(),
        scope,
        userId: owner.id,
        workflowId,
        command: 'pause',
      }),
      requestSupervisionCommand({
        db: fixture.db(),
        scope,
        userId: owner.id,
        workflowId,
        command: 'pause',
      }),
    ])

    const sequences = results.flatMap((result) => (result.applied ? [result.sequence] : []))
    expect([...sequences].sort()).toStrictEqual([1, 2])

    // The first pause was superseded by the second, so exactly one live command remains.
    const rows = await fixture
      .db()
      .select()
      .from(supervisionCommands)
      .where(eq(supervisionCommands.workflowId, workflowId))
    expect(rows.filter((row) => row.deliveryOutcome === 'pending')).toHaveLength(1)
  }, 30_000)

  it('holds the lock long enough that a plain read cannot be substituted', async () => {
    // A direct assertion on `lockWorkflowForTransition`: two transactions, the second held on the
    // same row, proving the helper itself locks rather than only the callers that happen to write.
    const owner = await fixture.seedUser('helper-lock')
    const workflowId = await fixture.seedWorkflow({ ownerUserId: owner.id, state: 'running' })

    const written = createGate()
    const release = createGate()

    const holder = fixture.db().transaction(async (writer) => {
      await lockWorkflowForTransition(writer, workflowId)
      await writer.update(workflows).set({ state: 'paused' }).where(eq(workflows.id, workflowId))
      written.open()
      await release.opened
    })

    await written.opened

    let secondSettled = false
    const second = fixture
      .db()
      .transaction(async (writer) => lockWorkflowForTransition(writer, workflowId))
      .finally(() => {
        secondSettled = true
      })

    expect(await waitForBlockedBackend(fixture)).toBeGreaterThan(0)
    expect(secondSettled).toBe(false)

    release.open()
    await holder

    // EvalPlanQual: the locking read re-fetches the newest committed version, so the loser sees
    // `paused` rather than the `running` it would have read before the race.
    expect(await second).toMatchObject({ state: 'paused' })
  }, 30_000)
})
