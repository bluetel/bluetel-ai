/* cspell:ignore datname */
import { randomUUID } from 'node:crypto'
import { inspect } from 'node:util'

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { workflowEntries, workflows } from '../../db'
import type { WorkflowState } from '../../enums'
import { TERMINAL_WORKFLOW_STATES, WORKFLOW_STATES } from '../../enums'

import {
  acquireBranchLocks,
  branchHeldError,
  branchLockKey,
  branchLockPairs,
  findBranchHolders,
  withBranchLocks,
} from './branch-lock'
import type { BranchLockPair } from './branch-lock'
import type { TwoProfileFixture } from './test-support'
import { createTwoProfileFixture, readTestDatabaseUrl, refusalOf } from './test-support'

/**
 * FR-120 — two non-terminal workflows may not hold the same repository and branch.
 *
 * The rule is about an *interleaving*, so the tests that prove it are the ones that interleave two
 * real transactions. A suite that only asserted "the second call was refused" would pass just as
 * happily against a check-then-write, which is exactly the implementation the advisory lock exists
 * to rule out — so the blocking test below waits for Postgres to report a backend parked on an
 * advisory lock before it believes anything.
 */

const API = 'https://git.test/lock/api.git'
const WEB = 'https://git.test/lock/web.git'

const pair = (repositoryUrl: string, baseBranch = 'main'): BranchLockPair => ({
  repositoryUrl,
  baseBranch,
})

describe('branchLockKey', () => {
  it('is the same for the same pair, every time and in every process', () => {
    expect(branchLockKey(pair(API))).toBe(branchLockKey(pair(API)))
  })

  it('differs when the repository differs', () => {
    expect(branchLockKey(pair(API))).not.toBe(branchLockKey(pair(WEB)))
  })

  it('differs when only the branch differs — a branch is half the identity', () => {
    expect(branchLockKey(pair(API, 'main'))).not.toBe(branchLockKey(pair(API, 'develop')))
  })

  it('fits a signed 64-bit integer, which is what pg_advisory_xact_lock takes', () => {
    for (const repository of [API, WEB, 'x', 'https://git.test/a/very/long/path/indeed.git']) {
      const key = BigInt(branchLockKey(pair(repository)))

      expect(key).toBeGreaterThanOrEqual(-(2n ** 63n))
      expect(key).toBeLessThan(2n ** 63n)
    }
  })

  it('does not normalise the pair beyond trimming', () => {
    // The probe compares these columns with `=`. Any normalisation the key applied and the query
    // did not would put two callers on one lock while telling them they were unrelated.
    expect(branchLockKey(pair(' https://git.test/lock/api.git '))).toBe(branchLockKey(pair(API)))
    expect(branchLockKey(pair('https://git.test/lock/API.git'))).not.toBe(branchLockKey(pair(API)))
  })
})

describe('branchLockPairs', () => {
  it('deduplicates two entries naming the same repository and branch', () => {
    expect(branchLockPairs([pair(API), pair(API), pair(WEB)])).toHaveLength(2)
  })

  it('keeps a repository’s two branches apart', () => {
    expect(branchLockPairs([pair(API, 'main'), pair(API, 'develop')])).toHaveLength(2)
  })

  it('puts every caller in the same order, whatever order they declared', () => {
    // The deadlock avoidance, asserted directly: two workspaces over the same repositories, listed
    // in opposite orders, take their locks in one order.
    const forwards = branchLockPairs([pair(API), pair(WEB)])
    const backwards = branchLockPairs([pair(WEB), pair(API)])

    expect(forwards).toEqual(backwards)
  })

  it('orders by lock key, not by name', () => {
    const ordered = branchLockPairs([pair(API), pair(WEB), pair(API, 'develop')])
    const keys = ordered.map(branchLockKey)

    expect([...keys].sort()).toEqual(keys)
  })
})

describe('branchHeldError', () => {
  it('is a conflict, not a refusal of the caller', () => {
    // The caller is entitled to ask; the world is wrong, and will stop being wrong by itself.
    expect(branchHeldError([{ workflowId: 'run-1', state: 'running', ...pair(API) }]).code).toBe(
      'CONFLICT',
    )
  })

  it('names the holding run, its state and the branch (FR-120)', () => {
    const message = branchHeldError([
      { workflowId: 'run-1', state: 'running', ...pair(API) },
    ]).message

    expect(message).toContain('run-1')
    expect(message).toContain('running')
    expect(message).toContain(API)
  })

  it('discloses nothing else about the holder', () => {
    const message = branchHeldError([
      { workflowId: 'run-1', state: 'paused', ...pair(API) },
    ]).message

    expect(message).not.toMatch(/owner|ticket|prompt|@/i)
  })
})

describe('the state partition the probe relies on', () => {
  it('is exactly the complement of the terminal states', () => {
    // `notInArray(terminal)` is only "every non-terminal holder" while these two partition the
    // vocabulary. If a state is added to neither list, this fails rather than the guard silently
    // letting a new kind of live run onto a held branch.
    const terminal = new Set<string>(TERMINAL_WORKFLOW_STATES)
    const active = WORKFLOW_STATES.filter((state) => !terminal.has(state))

    expect([...active, ...TERMINAL_WORKFLOW_STATES].sort()).toEqual([...WORKFLOW_STATES].sort())
  })
})

const connectionString = readTestDatabaseUrl()

/** A promise plus its resolver, for holding a transaction open at a chosen moment. */
const createGate = (): { readonly opened: Promise<void>; readonly open: () => void } => {
  let open = (): void => undefined
  const opened = new Promise<void>((resolve) => {
    open = () => {
      resolve()
    }
  })
  return { opened, open }
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

/**
 * The first element, honestly typed. `noUncheckedIndexedAccess` is off in this project, so `[0]` is
 * typed as present even when the array is empty.
 */
const firstOf = <TValue>(values: readonly TValue[]): TValue | undefined => values[0]

/**
 * A thrown value including its cause chain. Drizzle wraps what the driver reported, so the reason
 * Postgres gave is not on the top-level message; `inspect` walks the chain without this file having
 * to reach into a property whose type the configured lib does not admit.
 */
const describeCauses = (thrown: unknown): string => inspect(thrown, { depth: 5 })

describe.skipIf(connectionString === undefined)('branch locks against a live database', () => {
  let fixture: TwoProfileFixture

  beforeAll(async () => {
    fixture = createTwoProfileFixture(connectionString ?? '')
    await fixture.open()
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  /** A run holding one repository and branch, in whatever state. */
  const seedHolder = async (
    repositoryUrl: string,
    state: WorkflowState,
    baseBranch = 'main',
  ): Promise<string> => {
    const ids = fixture.ids()
    const rows = await fixture
      .db()
      .insert(workflows)
      .values({
        type: 'delegated',
        state,
        ownerUserId: ids.alice,
        setupBundleVersionId: ids.bundleVersion,
        workspaceVersionId: ids.a.workspaceVersionId,
        model: 'claude-opus-5',
        instanceType: 'm7i.large',
        purchaseMode: 'spot',
        sessionId: randomUUID(),
      })
      .returning({ id: workflows.id })

    const workflowId = firstOf(rows)?.id
    if (workflowId === undefined) {
      throw new Error('Seeding a holding workflow returned no row.')
    }

    await fixture.db().insert(workflowEntries).values({
      workflowId,
      workspaceEntryId: ids.a.workspaceEntryId,
      repositoryUrl,
      baseBranch,
      subdirectory: 'app',
    })

    return workflowId
  }

  /** Backends parked specifically on an advisory lock in this scratch database. */
  const waitingOnAdvisoryLocks = async (): Promise<number> => {
    const rows = (await fixture.db().execute(sql`
      select count(*)::int as blocked
        from pg_stat_activity
       where datname = current_database()
         and wait_event_type = 'Lock'
         and wait_event = 'advisory'`)) as unknown as readonly { readonly blocked: number }[]

    return rows[0]?.blocked ?? 0
  }

  it('lets a launch through when nothing holds the branch', async () => {
    const repository = `${API}#free-${randomUUID()}`

    await expect(
      withBranchLocks({
        db: fixture.db(),
        pairs: [pair(repository)],
        run: () => Promise.resolve('launched'),
      }),
    ).resolves.toBe('launched')
  })

  it('refuses a launch onto a branch a running workflow holds, naming it (FR-120)', async () => {
    const repository = `${API}#held-${randomUUID()}`
    const holder = await seedHolder(repository, 'running')
    let ran = false

    const refusal = await refusalOf(() =>
      withBranchLocks({
        db: fixture.db(),
        pairs: [pair(repository)],
        run: () => {
          ran = true
          return Promise.resolve('launched')
        },
      }),
    )

    expect(refusal.code).toBe('CONFLICT')
    expect(refusal.message).toContain(holder)
    // The refusal happens before the caller's work, so nothing is written on the way to it.
    expect(ran).toBe(false)
  })

  it('evaluates every entry of the workspace, not only the first (FR-120)', async () => {
    const free = `${API}#free-${randomUUID()}`
    const held = `${WEB}#held-${randomUUID()}`
    await seedHolder(held, 'paused')

    const refusal = await refusalOf(() =>
      withBranchLocks({
        db: fixture.db(),
        pairs: [pair(free), pair(held)],
        run: () => Promise.resolve('launched'),
      }),
    )

    expect(refusal.message).toContain(held)
  })

  it('does not treat a different branch of the same repository as held', async () => {
    const repository = `${API}#branches-${randomUUID()}`
    await seedHolder(repository, 'running', 'main')

    await expect(
      withBranchLocks({
        db: fixture.db(),
        pairs: [pair(repository, 'develop')],
        run: () => Promise.resolve('launched'),
      }),
    ).resolves.toBe('launched')
  })

  it.each([...TERMINAL_WORKFLOW_STATES])(
    'releases the branch once the holder is %s',
    async (state) => {
      const repository = `${API}#terminal-${state}-${randomUUID()}`
      await seedHolder(repository, state)

      await expect(
        withBranchLocks({
          db: fixture.db(),
          pairs: [pair(repository)],
          run: () => Promise.resolve('launched'),
        }),
      ).resolves.toBe('launched')
    },
  )

  it('does not refuse a run on account of its own entries', async () => {
    const repository = `${API}#self-${randomUUID()}`
    const holder = await seedHolder(repository, 'running')

    // A resume re-checking the branches it already holds must not conflict with itself.
    await expect(
      withBranchLocks({
        db: fixture.db(),
        pairs: [pair(repository)],
        excludeWorkflowId: holder,
        run: () => Promise.resolve('resumed'),
      }),
    ).resolves.toBe('resumed')
  })

  it('makes the second of two concurrent launches block on the lock, not race it', async () => {
    const repository = `${API}#race-${randomUUID()}`
    const held = createGate()
    const release = createGate()

    // The winner: holds the advisory lock and stays in its transaction.
    const winner = fixture.db().transaction(async (tx) => {
      await acquireBranchLocks(tx, [pair(repository)])
      held.open()
      await release.opened
      return 'winner'
    })

    await held.opened

    let loserSettled = false
    const loser = withBranchLocks({
      db: fixture.db(),
      pairs: [pair(repository)],
      run: () => Promise.resolve('loser'),
    }).finally(() => {
      loserSettled = true
    })

    // Without this the run in which the loser simply executed after the winner would look
    // identical to one where the lock made it wait, and only the second proves anything.
    let blocked = 0
    for (let attempt = 0; attempt < 200 && blocked === 0; attempt += 1) {
      await sleep(25)
      blocked = await waitingOnAdvisoryLocks()
    }

    expect(blocked).toBeGreaterThan(0)
    expect(loserSettled).toBe(false)

    release.open()
    await expect(winner).resolves.toBe('winner')
    await expect(loser).resolves.toBe('loser')
  }, 30_000)

  it('reads state committed by the transaction it waited for, not state from before', async () => {
    // The check-then-write this replaces: the loser's `select` would have run before the winner
    // committed and found nothing. Here it runs after the lock is released, so it sees the row.
    const repository = `${API}#committed-${randomUUID()}`
    const written = createGate()
    const release = createGate()
    const ids = fixture.ids()

    const winner = fixture.db().transaction(async (tx) => {
      await acquireBranchLocks(tx, [pair(repository)])

      const rows = await tx
        .insert(workflows)
        .values({
          type: 'delegated',
          state: 'queued',
          ownerUserId: ids.alice,
          setupBundleVersionId: ids.bundleVersion,
          workspaceVersionId: ids.a.workspaceVersionId,
          model: 'claude-opus-5',
          instanceType: 'm7i.large',
          purchaseMode: 'spot',
          sessionId: randomUUID(),
        })
        .returning({ id: workflows.id })

      const workflowId = rows[0]?.id ?? ''
      await tx.insert(workflowEntries).values({
        workflowId,
        workspaceEntryId: ids.a.workspaceEntryId,
        repositoryUrl: repository,
        baseBranch: 'main',
        subdirectory: 'app',
      })

      written.open()
      await release.opened
      return workflowId
    })

    await written.opened

    const loser = refusalOf(() =>
      withBranchLocks({
        db: fixture.db(),
        pairs: [pair(repository)],
        run: () => Promise.resolve('launched'),
      }),
    )

    await sleep(200)
    release.open()

    const winnerId = await winner
    expect((await loser).message).toContain(winnerId)
  }, 30_000)

  it('does not deadlock two workspaces that declare the same repositories in opposite orders', async () => {
    const first = `${API}#order-${randomUUID()}`
    const second = `${WEB}#order-${randomUUID()}`

    const results = await Promise.all([
      withBranchLocks({
        db: fixture.db(),
        pairs: [pair(first), pair(second)],
        run: async () => {
          await sleep(150)
          return 'forwards'
        },
      }),
      withBranchLocks({
        db: fixture.db(),
        pairs: [pair(second), pair(first)],
        run: async () => {
          await sleep(150)
          return 'backwards'
        },
      }),
    ])

    expect(results.sort()).toEqual(['backwards', 'forwards'])
  }, 30_000)

  it('deadlocks when the same locks are taken in opposite orders by hand', async () => {
    // The hazard `branchLockPairs` sorts to avoid, demonstrated rather than asserted about. Without
    // one global order, this is what a pair of multi-repository launches does.
    const left = branchLockKey(pair(`${API}#deadlock-${randomUUID()}`))
    const right = branchLockKey(pair(`${WEB}#deadlock-${randomUUID()}`))
    const heldFirst = createGate()
    const heldSecond = createGate()

    const forwards = fixture.db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${left}::bigint)`)
      heldFirst.open()
      await heldSecond.opened
      await tx.execute(sql`select pg_advisory_xact_lock(${right}::bigint)`)
    })

    const backwards = fixture.db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${right}::bigint)`)
      heldSecond.open()
      await heldFirst.opened
      await tx.execute(sql`select pg_advisory_xact_lock(${left}::bigint)`)
    })

    const settled = await Promise.allSettled([forwards, backwards])
    const rejected = settled.filter((result) => result.status === 'rejected')

    expect(rejected).toHaveLength(1)
    // Drizzle wraps the driver error, so the reason Postgres gave is on the cause chain.
    expect(describeCauses(firstOf(rejected)?.reason)).toMatch(/deadlock/i)
  }, 30_000)

  it('finds holders directly, so the guard’s probe is testable on its own', async () => {
    const repository = `${API}#probe-${randomUUID()}`
    const holder = await seedHolder(repository, 'provisioning')

    const holders = await findBranchHolders(fixture.db(), [pair(repository)])

    expect(holders).toMatchObject([
      { workflowId: holder, state: 'provisioning', repositoryUrl: repository, baseBranch: 'main' },
    ])
  })

  it('answers nothing for an empty workspace rather than querying for everything', async () => {
    expect(await findBranchHolders(fixture.db(), [])).toEqual([])
  })
})
