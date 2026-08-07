import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { AdmittedWorkflow, WorkflowStarter } from './admit-workflow'
import { admitWorkflow } from './admit-workflow'
import { drainQueue, runDrainQueue } from './drain-queue'
import { createWorkflowFixtures, readTestDatabaseUrl } from './workflow-fixtures'

/**
 * The drain exists so the ceiling does not build a queue nothing empties, so these tests are about
 * the queue actually emptying — in admission order, and without a concurrent drain admitting
 * anything twice.
 */

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

/** Recording stand-in for `start-workflow.ts` (T052), which does not exist yet. */
const createRecordingStarter = (
  onStart?: (input: AdmittedWorkflow) => Promise<void>,
): WorkflowStarter & { readonly started: readonly string[] } => {
  const started: string[] = []
  return {
    started,
    start: async (input) => {
      started.push(input.workflowId)
      await onStart?.(input)
    },
  }
}

describeWithDatabase('the queue drain against a live database', () => {
  const fixtures = createWorkflowFixtures(connectionString ?? '')

  beforeAll(() => fixtures.open(), 60_000)
  afterEach(() => fixtures.removeAll())
  afterAll(() => fixtures.close())

  /** Three queued workflows, oldest first, created a minute apart so order is data not timing. */
  const seedQueue = async (): Promise<readonly string[]> => {
    const first = await fixtures.seedWorkflow({
      label: 'first',
      createdAt: new Date('2026-08-05T09:00:00.000Z'),
    })
    const second = await fixtures.seedWorkflow({
      label: 'second',
      createdAt: new Date('2026-08-05T09:01:00.000Z'),
    })
    const third = await fixtures.seedWorkflow({
      label: 'third',
      createdAt: new Date('2026-08-05T09:02:00.000Z'),
    })
    return [first, second, third]
  }

  it('empties the queue in admission order when the ceiling allows', async () => {
    const queue = await seedQueue()

    const result = await drainQueue({ db: fixtures.db(), ceiling: 5 })

    expect(result.admitted.map((admission) => admission.workflowId)).toEqual([...queue])
    expect(result.remainingQueued).toBe(0)
    expect(result.ceilingReached).toBe(false)
    expect(await fixtures.countLiveLeases()).toBe(3)
  })

  it('stops at the ceiling and leaves the rest queued, oldest admitted first', async () => {
    const [first, second, third] = await seedQueue()

    const result = await drainQueue({ db: fixtures.db(), ceiling: 2 })

    expect(result.admitted.map((admission) => admission.workflowId)).toEqual([first, second])
    expect(result.ceilingReached).toBe(true)
    expect(result.remainingQueued).toBe(1)
    expect(await fixtures.stateOf(third)).toBe('queued')
  })

  it('does nothing at all when the ceiling is already full', async () => {
    const holder = await fixtures.seedWorkflow({ label: 'holder', state: 'provisioning' })
    await fixtures.seedLease(holder)
    const waiting = await fixtures.seedWorkflow({ label: 'waiting' })

    const result = await drainQueue({ db: fixtures.db(), ceiling: 1 })

    expect(result).toMatchObject({ admitted: [], ceilingReached: true, remainingQueued: 1 })
    expect(await fixtures.countLeasesFor(waiting)).toBe(0)
  })

  it('re-admits when a lease releases — the queue empties over successive drains', async () => {
    const [first, second] = await seedQueue()

    const firstDrain = await drainQueue({ db: fixtures.db(), ceiling: 1 })
    expect(firstDrain.admitted.map((admission) => admission.workflowId)).toEqual([first])

    // Nothing has changed, so a second drain admits nothing — the ceiling is still full.
    expect((await drainQueue({ db: fixtures.db(), ceiling: 1 })).admitted).toEqual([])

    const leaseId = firstDrain.admitted[0]?.leaseId ?? ''
    await fixtures.releaseLease(leaseId)

    // Teardown (T066) calls the drain after releasing; this is that call.
    const afterRelease = await drainQueue({ db: fixtures.db(), ceiling: 1 })
    expect(afterRelease.admitted.map((admission) => admission.workflowId)).toEqual([second])
    expect(afterRelease.remainingQueued).toBe(1)
  })

  it('honours a limit so one invocation cannot run unboundedly', async () => {
    await seedQueue()

    const result = await drainQueue({ db: fixtures.db(), ceiling: 10, limit: 2 })

    expect(result.admitted).toHaveLength(2)
    expect(result.remainingQueued).toBe(1)
    // Stopped on the limit, not on the ceiling — the difference matters to whoever reads this.
    expect(result.ceilingReached).toBe(false)
  })

  it('hands each admitted workflow to provisioning, in order', async () => {
    const queue = await seedQueue()
    const starter = createRecordingStarter()

    await drainQueue({ db: fixtures.db(), ceiling: 5, starter })

    expect(starter.started).toEqual([...queue])
  })

  it('records a provisioning failure and keeps draining, leaving the lease for the reconciler', async () => {
    const [first, second, third] = await seedQueue()
    const starter = createRecordingStarter((input) =>
      input.workflowId === first
        ? Promise.reject(new Error('InsufficientInstanceCapacity'))
        : Promise.resolve(),
    )

    const result = await drainQueue({ db: fixtures.db(), ceiling: 5, starter })

    expect(result.startFailures).toMatchObject([{ workflowId: first }])
    expect(result.startFailures[0]?.error.message).toBe('InsufficientInstanceCapacity')
    expect(starter.started).toEqual([first, second, third])
    // The workflow stays admitted with its lease: an FR-039 sweep releases it, and losing the
    // failure here would leave a lease nobody knows about.
    expect(await fixtures.stateOf(first)).toBe('provisioning')
    expect(await fixtures.countLiveLeases()).toBe(3)
  })

  it('does not count a workflow admitted by someone else mid-drain', async () => {
    const [first, second, third] = await seedQueue()

    // The interleave, made deterministic: while the drain is handing `first` to provisioning,
    // something else admits `second` — exactly the window a concurrent drain occupies. `second` is
    // already on this drain's candidate list, so the drain will reach it and find it leased.
    const starter = createRecordingStarter(async (input) => {
      if (input.workflowId === first) {
        await admitWorkflow({ db: fixtures.db(), workflowId: second, ceiling: 5 })
      }
    })

    const result = await drainQueue({ db: fixtures.db(), ceiling: 5, starter })

    // `second` was admitted — but not by this drain, so it is not in `admitted` and was never
    // handed to provisioning. Counting a coalesce is how a drain double-starts a workflow.
    expect(result.admitted.map((admission) => admission.workflowId)).toEqual([first, third])
    expect(starter.started).toEqual([first, third])
    expect(await fixtures.countLeasesFor(second)).toBe(1)
    expect(await fixtures.countLiveLeases()).toBe(3)
  })

  it('does not double-admit when two drains race (FR-078)', async () => {
    const queue = await seedQueue()
    const firstStarter = createRecordingStarter()
    const secondStarter = createRecordingStarter()

    const [left, right] = await Promise.all([
      drainQueue({ db: fixtures.db(), ceiling: 5, starter: firstStarter }),
      drainQueue({ db: fixtures.db(), ceiling: 5, starter: secondStarter }),
    ])

    const admitted = [...left.admitted, ...right.admitted].map((admission) => admission.workflowId)
    // Every workflow admitted exactly once, across both drains — the loser of each contest saw a
    // `coalesced` outcome, which the drain does not count.
    expect([...admitted].sort()).toEqual([...queue].sort())
    expect(new Set(admitted).size).toBe(3)
    expect(await fixtures.countLiveLeases()).toBe(3)

    for (const workflowId of queue) {
      expect(await fixtures.countLeasesFor(workflowId)).toBe(1)
    }
    // And nothing was handed to provisioning twice, which is what a double-admit would have cost.
    expect([...firstStarter.started, ...secondStarter.started].sort()).toEqual([...queue].sort())
  }, 30_000)

  it('races two drains against a ceiling of one and admits exactly one workflow', async () => {
    await seedQueue()

    const [left, right] = await Promise.all([
      drainQueue({ db: fixtures.db(), ceiling: 1 }),
      drainQueue({ db: fixtures.db(), ceiling: 1 }),
    ])

    expect(left.admitted.length + right.admitted.length).toBe(1)
    expect(await fixtures.countLiveLeases()).toBe(1)
  }, 30_000)

  it('reports through the uniform job envelope', async () => {
    await seedQueue()

    const outcome = await runDrainQueue({ db: fixtures.db(), ceiling: 5 })

    expect(outcome.ok).toBe(true)
    expect(outcome.ok ? outcome.value.admitted : []).toHaveLength(3)
    expect(outcome.jobName).toBe('drain-queue')
  })
})
