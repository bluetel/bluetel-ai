import { eq, sql } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { BOOTSTRAP_PHASES, CREDENTIAL_STATES, WORKFLOW_STATES } from '../../enums'
import type { UserFixtures } from '../../server/admin/test-database'
import {
  createGate,
  createUserFixtures,
  readTestDatabaseUrl,
} from '../../server/admin/test-database'

import {
  agentCredentials,
  credentialGroups,
  credentialLeases,
  keepAliveRuns,
  profileCredentialGroups,
} from './credential'
import { columnOf, describeTable, indexOf, referencedTables } from './introspect'

/**
 * The credential pool's schema, proved twice over.
 *
 * Most of this file asserts against Drizzle's own metadata, the way every other schema suite here
 * does — it answers "does this table still have the shape the data model requires" on a laptop
 * with no Postgres, and against the definition migrations are generated from rather than against
 * whatever a developer's database happens to contain.
 *
 * **The exclusivity index is the exception, and deliberately.** `credential_leases_live_key` is
 * the entire safety property of this feature: one agent identity, one run, never two (FR-017,
 * SC-003). Asserting that the index *is declared* would only prove that somebody typed it; the
 * claim being made is about what Postgres does when two acquisitions race, and only Postgres can
 * settle that. So the second half of this file runs against a real, freshly-migrated database and
 * makes the race happen. The suite skips when `SISYPHUS_TEST_DATABASE_URL` is unset and fails in
 * CI when it is — see `server/admin/test-database.ts` for why that asymmetry exists.
 */

const connectionString = readTestDatabaseUrl()

const CREDENTIAL_TABLES: readonly PgTable[] = [
  credentialGroups,
  agentCredentials,
  credentialLeases,
  profileCredentialGroups,
  keepAliveRuns,
]

/**
 * Column names that would mean material had been put in Postgres, in violation of FR-011.
 *
 * This is a deliberately blunt instrument aimed at the realistic failure: not somebody maliciously
 * adding `password`, but somebody adding `refresh_token` or `session_cookie` during a later phase
 * because it was momentarily convenient, and nobody noticing in review. A pattern match on names
 * catches that, and costs a one-line justification when a genuinely innocent name collides.
 */
const MATERIAL_PATTERN =
  /token|password|passphrase|secret|material|cookie|refresh|api_key|access_key|private_key|session_key|bearer|oauth|jwt/

/**
 * The one column whose name touches the pattern and is allowed to. `secret_id` is a Secrets
 * Manager *identifier* — a name under which material is filed elsewhere (research R8) — and it is
 * listed here rather than pattern-exempted so that adding a second exception is a visible edit.
 */
const REFERENCE_ONLY_COLUMNS = new Set(['secret_id'])

describe('the credential pool schema', () => {
  it('holds no credential material in any column of any table (FR-011)', () => {
    for (const table of CREDENTIAL_TABLES) {
      const shape = describeTable(table)
      for (const column of shape.columns) {
        if (REFERENCE_ONLY_COLUMNS.has(column.name)) continue
        expect(column.name, `${shape.name}.${column.name} looks like material`).not.toMatch(
          MATERIAL_PATTERN,
        )
      }
    }
  })

  it('keeps secret_id a nullable identifier, which is the only reference to the store', () => {
    // Null until a login has succeeded. That is FR-008 as a data rule: a credential with nowhere
    // to fetch material from cannot be issued to a workflow by any code path.
    expect(columnOf(agentCredentials, 'secret_id').type).toBe('text')
    expect(columnOf(agentCredentials, 'secret_id').notNull).toBe(false)

    const matches = CREDENTIAL_TABLES.flatMap((table) =>
      describeTable(table)
        .columns.map((column) => column.name)
        .filter((name) => MATERIAL_PATTERN.test(name)),
    )
    expect(matches).toStrictEqual(['secret_id'])
  })
})

describe('credential_groups', () => {
  it('is named uniquely platform-wide, case-insensitively (FR-060)', () => {
    expect(columnOf(credentialGroups, 'name').type).toBe('citext')
    expect(indexOf(credentialGroups, 'credential_groups_name_key').unique).toBe(true)
  })

  it('is disabled rather than deleted, and soft-deleted at worst (FR-066)', () => {
    expect(columnOf(credentialGroups, 'enabled').defaultValue).toBe(true)
    expect(columnOf(credentialGroups, 'archived_at').notNull).toBe(false)
  })

  it('attributes creation to an administrator (FR-004)', () => {
    expect(columnOf(credentialGroups, 'created_by_user_id').notNull).toBe(true)
    expect(referencedTables(credentialGroups)).toStrictEqual(['users'])
  })
})

describe('agent_credentials', () => {
  it('belongs to exactly one group, assigned at registration (FR-061)', () => {
    expect(columnOf(agentCredentials, 'credential_group_id').notNull).toBe(true)
    expect([...referencedTables(agentCredentials)].sort()).toStrictEqual([
      'credential_groups',
      'users',
    ])
  })

  it('names no agent vendor anywhere in its columns (FR-003)', () => {
    // The adapter boundary in 002 exists so the backend stays swappable. A column called
    // `anthropic_…` or `openai_…` would spend it for nothing.
    const names = describeTable(agentCredentials).columns.map((column) => column.name)
    for (const name of names) {
      expect(name).not.toMatch(/anthropic|claude|openai|gemini|vendor|provider_name/)
    }
  })

  it('carries the fence on the credential, so it outlives the lease that raised it (FR-020, R9)', () => {
    // On the lease, the token would vanish with the row that a force-release stops being live,
    // and the displaced holder's next write would land on material the new holder now owns.
    const fence = columnOf(agentCredentials, 'fence')
    expect(fence.type).toBe('bigint')
    expect(fence.notNull).toBe(true)
    expect(fence.defaultValue).toBe(0)
  })

  it('discriminates a workflow holder from a keep-alive one while held (FR-038, FR-074)', () => {
    // Both claim through the same conditional `UPDATE … WHERE state = 'available'`, so exactly one
    // wins. Keep-alive cannot say so with a lease row — `credential_leases.workflow_id` is not
    // null and a keep-alive has no workflow — so the discriminator has to live here.
    expect(columnOf(agentCredentials, 'held_by').type).toBe('text')
    expect(columnOf(agentCredentials, 'held_by').notNull).toBe(false)
    expect(columnOf(credentialLeases, 'workflow_id').notNull).toBe(true)
  })

  it('records liveness in one column written by two mechanisms (FR-035, FR-036)', () => {
    // Splitting keep-alive evidence from workflow evidence would let a credential look idle to the
    // scheduler immediately after a run had proved otherwise.
    const names = describeTable(agentCredentials).columns.map((column) => column.name)
    expect(names).toContain('last_exercised_at')
    expect(names).not.toContain('last_keep_alive_at')
    expect(columnOf(agentCredentials, 'last_used_at').notNull).toBe(false)
  })

  it('draws its state from the shared vocabulary, where only available is selectable', () => {
    expect(columnOf(agentCredentials, 'state').type).toBe('credential_state')
    expect(columnOf(agentCredentials, 'state').notNull).toBe(true)
    expect(CREDENTIAL_STATES).toContain('available')
  })

  it('leaves cooling_off_until nullable, because a provider need not give a retry time (FR-078)', () => {
    expect(columnOf(agentCredentials, 'cooling_off_until').notNull).toBe(false)
  })

  it('makes a failed login visible against the credential, not only in a log (FR-009)', () => {
    expect(columnOf(agentCredentials, 'last_failure_reason').type).toBe('text')
    expect(columnOf(agentCredentials, 'last_failure_reason').notNull).toBe(false)
  })

  it('is disabled or archived, never hard-deleted once used (FR-005, FR-006)', () => {
    expect(columnOf(agentCredentials, 'enabled').defaultValue).toBe(true)
    expect(columnOf(agentCredentials, 'archived_at').notNull).toBe(false)
  })

  it('indexes least-recently-used selection within a group (FR-034)', () => {
    const selection = indexOf(agentCredentials, 'agent_credentials_group_selection_idx')
    expect(selection.unique).toBe(false)
    expect(selection.columns).toStrictEqual(['credential_group_id', 'state', 'last_used_at'])
  })

  it('indexes keep-alive scheduling and the cooling-off sweep partially (FR-035, FR-076)', () => {
    const keepAlive = indexOf(agentCredentials, 'agent_credentials_keep_alive_idx')
    expect(keepAlive.columns).toStrictEqual(['state', 'last_exercised_at'])
    expect(keepAlive.where).toBe(`"agent_credentials"."state" = 'available'`)

    const coolingOff = indexOf(agentCredentials, 'agent_credentials_cooling_off_idx')
    expect(coolingOff.columns).toStrictEqual(['state', 'cooling_off_until'])
    expect(coolingOff.where).toBe(`"agent_credentials"."state" = 'cooling_off'`)
  })
})

describe('credential_leases', () => {
  it('declares the exclusivity gate as a partial unique index (FR-017, SC-003)', () => {
    const live = indexOf(credentialLeases, 'credential_leases_live_key')
    expect(live.unique).toBe(true)
    expect(live.columns).toStrictEqual(['agent_credential_id'])
    // Partial, not a plain unique constraint: a credential is legitimately leased many times over
    // its life, and only one of those leases may be live at once.
    expect(live.where).toBe('"credential_leases"."released_at" is null')
  })

  it('declares the one-seat-per-workflow index the same way (FR-015)', () => {
    const workflowLive = indexOf(credentialLeases, 'credential_leases_workflow_live_key')
    expect(workflowLive.unique).toBe(true)
    expect(workflowLive.columns).toStrictEqual(['workflow_id'])
    expect(workflowLive.where).toBe('"credential_leases"."released_at" is null')
  })

  it('keeps the reconciliation sweep off the released leases it will never look at (FR-022)', () => {
    const unreleased = indexOf(credentialLeases, 'credential_leases_unreleased_idx')
    expect(unreleased.unique).toBe(false)
    expect(unreleased.columns).toStrictEqual(['released_at'])
    expect(unreleased.where).toBe('"credential_leases"."released_at" is null')
  })

  it('belongs to a workflow and to no execution environment (FR-018, FR-019)', () => {
    // A lease survives pause, park, and the destruction of every instance the run ever had.
    // Environment lifecycle is `compute_leases`; conflating the two is the mistake this avoids.
    expect([...referencedTables(credentialLeases)].sort()).toStrictEqual([
      'agent_credentials',
      'users',
      'workflows',
    ])
    const names = describeTable(credentialLeases).columns.map((column) => column.name)
    expect(names).not.toContain('compute_lease_id')
    expect(names).not.toContain('provider_instance_id')
  })

  it('carries the fence it was issued, with no default to fall back on (FR-020)', () => {
    // Unlike the credential's own fence, this one is never zero by accident: it is whatever
    // acquisition raised the credential to, and a default would quietly make a stale write valid.
    expect(columnOf(credentialLeases, 'fence').type).toBe('bigint')
    expect(columnOf(credentialLeases, 'fence').notNull).toBe(true)
    expect(columnOf(credentialLeases, 'fence').hasDefault).toBe(false)
  })

  it('is never mutated except to write the release (FR-015, FR-019)', () => {
    const names = describeTable(credentialLeases).columns.map((column) => column.name)
    expect(names).not.toContain('updated_at')
    expect(columnOf(credentialLeases, 'acquired_at').notNull).toBe(true)
    expect(columnOf(credentialLeases, 'released_at').notNull).toBe(false)
    expect(columnOf(credentialLeases, 'release_reason').type).toBe('credential_release_reason')
    expect(columnOf(credentialLeases, 'release_reason').notNull).toBe(false)
  })

  it('names the person only when a person forced it (FR-057, SC-015)', () => {
    // The reconciliation sweep also records `forced`, and leaves this null — which is what tells
    // an administrator seizing a seat apart from the platform tidying up after a vanished run.
    expect(columnOf(credentialLeases, 'released_by_user_id').notNull).toBe(false)
  })
})

describe('profile_credential_groups', () => {
  it('attaches to the mutable profile, not to a profile version (FR-062)', () => {
    // Against 002's pattern for launch values, and on purpose: pinning the pool to a version would
    // make a historical run impossible to launch again after the pool changed, and would mint a
    // profile version every time an attachment was edited.
    expect([...referencedTables(profileCredentialGroups)].sort()).toStrictEqual([
      'credential_groups',
      'execution_profiles',
    ])
    const names = describeTable(profileCredentialGroups).columns.map((column) => column.name)
    expect(names).not.toContain('execution_profile_version_id')
  })

  it('makes the preference order total, and duplicate attachment impossible', () => {
    const position = indexOf(profileCredentialGroups, 'profile_credential_groups_position_key')
    expect(position.unique).toBe(true)
    expect(position.columns).toStrictEqual(['execution_profile_id', 'position'])

    const group = indexOf(profileCredentialGroups, 'profile_credential_groups_group_key')
    expect(group.unique).toBe(true)
    expect(group.columns).toStrictEqual(['execution_profile_id', 'credential_group_id'])
  })
})

describe('keep_alive_runs', () => {
  it('is append-only, so the R2 idle window becomes measurable rather than assumed', () => {
    const names = describeTable(keepAliveRuns).columns.map((column) => column.name)
    expect(names).not.toContain('updated_at')
    expect(columnOf(keepAliveRuns, 'ran_at').notNull).toBe(true)
    expect(columnOf(keepAliveRuns, 'ran_at').hasDefault).toBe(true)
  })

  it('records an outcome and a detail that never contains material (FR-037)', () => {
    expect(columnOf(keepAliveRuns, 'outcome').notNull).toBe(true)
    expect(columnOf(keepAliveRuns, 'detail').notNull).toBe(false)
    expect(referencedTables(keepAliveRuns)).toStrictEqual(['agent_credentials'])
  })
})

// --- Against a real database ----------------------------------------------------------------

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

/**
 * The name of the index a write was refused by.
 *
 * Asserted on rather than the error message, and the difference matters: Drizzle wraps the driver
 * error in one whose `message` is the failing SQL, so a `toThrow(/…_live_key/)` would pass on any
 * insert into `credential_leases` that failed for any reason at all — including a null violation or
 * a missing foreign key. `constraint_name` comes from Postgres and names the exact index that
 * rejected the row, which is the claim these tests are making.
 */
const refusedBy = async (write: () => Promise<unknown>): Promise<string> => {
  try {
    await write()
  } catch (error) {
    // `Error.cause` is ES2022 and this package compiles against ES2020, so it is read structurally.
    const cause: unknown = (error as { cause?: unknown }).cause ?? error
    const name = (cause as { constraint_name?: unknown }).constraint_name
    if (typeof name === 'string') return name
    throw error
  }
  throw new Error('Expected the write to be refused, but it committed.')
}

interface SeededPool {
  readonly groupId: string
  readonly credentialA: string
  readonly credentialB: string
  readonly workflowA: string
  readonly workflowB: string
}

describe.skipIf(connectionString === undefined)('the credential pool, against Postgres', () => {
  // Narrowed once: `describe.skipIf` has already decided, but TypeScript has not seen it.
  const url = connectionString ?? ''
  const fixtures: UserFixtures = createUserFixtures(url)
  let ownerId = ''
  let pool: SeededPool

  const seedPool = async (): Promise<SeededPool> => {
    const db = fixtures.db()
    const [group] = await db
      .insert(credentialGroups)
      .values({ name: `pool-${fixtures.suffix}`, createdByUserId: ownerId })
      .returning({ id: credentialGroups.id })

    const seedCredential = async (label: string): Promise<string> => {
      const [row] = await db
        .insert(agentCredentials)
        .values({
          credentialGroupId: group.id,
          name: `credential-${fixtures.suffix}-${label}`,
          state: 'available',
          secretId: `sisyphus/agent-credential/${fixtures.suffix}-${label}`,
          createdByUserId: ownerId,
        })
        .returning({ id: agentCredentials.id })
      return row.id
    }

    return {
      groupId: group.id,
      credentialA: await seedCredential('a'),
      credentialB: await seedCredential('b'),
      workflowA: await fixtures.seedWorkflow({ ownerUserId: ownerId, state: 'running' }),
      workflowB: await fixtures.seedWorkflow({ ownerUserId: ownerId, state: 'running' }),
    }
  }

  /** One acquisition, as the allocator would write it: the credential's fence, on a live lease. */
  const acquire = async (agentCredentialId: string, workflowId: string): Promise<string> => {
    const [row] = await fixtures
      .db()
      .insert(credentialLeases)
      .values({ agentCredentialId, workflowId, fence: 1 })
      .returning({ id: credentialLeases.id })
    return row.id
  }

  beforeAll(async () => {
    await fixtures.open()
    const owner = await fixtures.seedUser({ label: 'pool-owner', role: 'admin' })
    ownerId = owner.id
  }, 120_000)

  afterAll(async () => {
    await fixtures.close()
  })

  beforeAll(async () => {
    pool = await seedPool()
  })

  afterEach(async () => {
    // Only the lease rows change between tests; the pool and the two workflows are reused, so
    // every test starts from "two idle credentials, two runs holding nothing".
    await fixtures.db().delete(credentialLeases)
  })

  it('applied the migration that adds awaiting_credential to workflow_state (FR-024, R10)', async () => {
    const rows = await fixtures.db().execute<{
      value: string
    }>(sql`select unnest(enum_range(null::workflow_state))::text as value`)
    expect([...rows].map((row) => row.value)).toStrictEqual([...WORKFLOW_STATES])
  })

  it('inserted credential_install mid-order, rather than appending it (FR-049, R7)', async () => {
    // The enum's order *is* the vocabulary: appending would have placed credential installation
    // after `agent_start`, which is wrong and would not be detectable from a stored row later.
    // Comparing the whole range against the TypeScript tuple is what makes an append fail here.
    const rows = await fixtures.db().execute<{
      value: string
    }>(sql`select unnest(enum_range(null::bootstrap_phase))::text as value`)
    const phases = [...rows].map((row) => row.value)
    expect(phases).toStrictEqual([...BOOTSTRAP_PHASES])
    expect(phases.indexOf('credential_install')).toBe(phases.indexOf('setup_script') + 1)
    expect(phases.indexOf('credential_install')).toBe(phases.indexOf('entry_checkout') - 1)
  })

  it('refuses a second live lease on one credential (FR-017, SC-003)', async () => {
    await acquire(pool.credentialA, pool.workflowA)
    // A different workflow, the same seat. This is the whole guarantee.
    await expect(refusedBy(async () => acquire(pool.credentialA, pool.workflowB))).resolves.toBe(
      'credential_leases_live_key',
    )
  })

  it('refuses two live leases for one workflow, on two different credentials (FR-015)', async () => {
    await acquire(pool.credentialA, pool.workflowA)
    await expect(refusedBy(async () => acquire(pool.credentialB, pool.workflowA))).resolves.toBe(
      'credential_leases_workflow_live_key',
    )
  })

  it('frees the seat once the lease is released, in both directions', async () => {
    // The index would be a correctness bug in the other direction if it did not: a credential
    // whose run has ended must be re-leasable, and a workflow that gave a seat back must be able
    // to be granted another one after a re-launch.
    const first = await acquire(pool.credentialA, pool.workflowA)
    await fixtures
      .db()
      .update(credentialLeases)
      .set({ releasedAt: new Date(), releaseReason: 'terminal' })
      .where(eq(credentialLeases.id, first))

    await expect(acquire(pool.credentialA, pool.workflowB)).resolves.toBeTypeOf('string')
    await expect(acquire(pool.credentialB, pool.workflowA)).resolves.toBeTypeOf('string')
  })

  it('lets a credential be leased any number of times, so long as one at a time', async () => {
    for (let round = 0; round < 3; round += 1) {
      const id = await acquire(pool.credentialA, round % 2 === 0 ? pool.workflowA : pool.workflowB)
      await fixtures
        .db()
        .update(credentialLeases)
        .set({ releasedAt: new Date(), releaseReason: 'terminal' })
        .where(eq(credentialLeases.id, id))
    }
    const live = await fixtures.db().select().from(credentialLeases)
    expect(live).toHaveLength(3)
    expect(live.filter((lease) => lease.releasedAt === null)).toHaveLength(0)
  })

  it('lets only one of two concurrent acquisitions commit (FR-017, SC-003)', async () => {
    // The sequential cases above prove the index rejects a duplicate. This proves the thing the
    // index exists for: two allocators that both looked at an idle credential and both decided to
    // take it. The loser does not merely lose — it blocks on the index until the winner commits,
    // which is Postgres deciding the race rather than application timing deciding it.
    const inserted = createGate()
    const release = createGate()

    const winner = fixtures.db().transaction(async (tx) => {
      await tx
        .insert(credentialLeases)
        .values({ agentCredentialId: pool.credentialA, workflowId: pool.workflowA, fence: 1 })
      inserted.open()
      await release.opened
      return 'committed'
    })

    await inserted.opened
    expect(await fixtures.backendsInTransaction()).toBeGreaterThan(0)

    let loserSettled = false
    const loser = fixtures
      .db()
      .transaction(async (tx) => {
        await tx
          .insert(credentialLeases)
          .values({ agentCredentialId: pool.credentialA, workflowId: pool.workflowB, fence: 2 })
      })
      .finally(() => {
        loserSettled = true
      })
    // Attached now rather than after `release.open()`, so the rejection is never momentarily
    // unhandled — and so this promise is what the assertion at the end reads.
    const loserRefusal = refusedBy(async () => loser)

    // Without this, a run in which the loser simply executed after the winner would look identical
    // to one in which the index made it wait — and only the second proves anything.
    let blocked = 0
    for (let attempt = 0; attempt < 200 && blocked === 0; attempt += 1) {
      await sleep(25)
      blocked = await fixtures.backendsWaitingOnLocks()
    }
    expect(blocked).toBeGreaterThan(0)
    expect(loserSettled).toBe(false)

    release.open()
    await expect(winner).resolves.toBe('committed')
    await expect(loserRefusal).resolves.toBe('credential_leases_live_key')

    const leases = await fixtures.db().select().from(credentialLeases)
    expect(leases).toHaveLength(1)
    expect(leases[0]?.workflowId).toBe(pool.workflowA)
  }, 30_000)
})
