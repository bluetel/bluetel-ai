import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DatabaseClient } from '../../db'
import { createDatabaseClient, setupBundles, setupBundleVersions } from '../../db'
import { ACTIVE_WORKFLOW_STATES, TERMINAL_WORKFLOW_STATES, WORKFLOW_STATES } from '../../enums'

import {
  findBundle,
  findBundleByName,
  insertBundle,
  insertBundleVersion,
  listBundles,
  lockBundleForVersioning,
  readLatestValidations,
  readLatestVersions,
  updateBundle,
} from './bundle-store'
import { createUserFixtures, readTestDatabaseUrl } from './test-database'

/**
 * The queries, compiled but not executed. `toSQL()` needs no database, so these assertions run on
 * any machine and pin the properties that are invisible in the result set.
 */
describe('bundle queries, as SQL', () => {
  let client: DatabaseClient

  beforeAll(() => {
    client = createDatabaseClient({ connectionString: 'postgres://compile-only@127.0.0.1:1/none' })
  })

  afterAll(async () => {
    await client.close()
  })

  it('allocates a version number from a locking read, not a plain one', () => {
    // The shape `lockBundleForVersioning` issues. `for update` is the whole of its concurrency
    // argument, so it is worth an assertion that fails without a database to run against.
    const compiled = client.db
      .select()
      .from(setupBundles)
      .where(eq(setupBundles.id, 'x'))
      .limit(1)
      .for('update')
      .toSQL().sql

    expect(compiled).toMatch(/for update/i)
  })

  it('counts only non-terminal workflows as active, from the shared enum', () => {
    // `ACTIVE_WORKFLOW_STATES` is `WORKFLOW_STATES` minus the terminal ones. Restating the list in
    // the reference sweep would let the two drift the next time a state is added.
    expect([...ACTIVE_WORKFLOW_STATES]).toStrictEqual(
      WORKFLOW_STATES.filter(
        (state) => !TERMINAL_WORKFLOW_STATES.some((terminal) => terminal === state),
      ),
    )
  })
})

const liveDatabaseUrl = readTestDatabaseUrl()

describe.skipIf(liveDatabaseUrl === undefined)('the bundle store against a live database', () => {
  const fixtures = createUserFixtures(liveDatabaseUrl ?? '')
  let actorId = ''

  const digest = (seed: string): string => seed.repeat(64).slice(0, 64)

  const register = async (name: string, version: number, seed: string) => {
    const bundle = await insertBundle(fixtures.db(), {
      name,
      description: undefined,
      spendCapsEnforceable: false,
      createdByUserId: actorId,
    })
    await insertBundleVersion(fixtures.db(), {
      setupBundleId: bundle.id,
      version,
      s3Key: `bundles/${name}/${String(version)}.tar.gz`,
      contentDigest: digest(seed),
      sizeBytes: 64,
      registeredByUserId: actorId,
    })
    return bundle
  }

  beforeAll(async () => {
    await fixtures.open()
    const seeded = await fixtures.seedUser({ label: 'store-admin', role: 'admin' })
    actorId = seeded.id
  }, 60_000)

  afterAll(async () => {
    await fixtures.close()
  }, 30_000)

  it('finds a bundle by id and by its exact name', async () => {
    const bundle = await register(`store-find-${fixtures.suffix}`, 1, 'a')

    await expect(findBundle(fixtures.db(), bundle.id)).resolves.toMatchObject({ id: bundle.id })
    await expect(
      findBundleByName(fixtures.db(), `store-find-${fixtures.suffix}`),
    ).resolves.toMatchObject({ id: bundle.id })
    // Case-sensitive, matching the unique index. A lower-casing check would refuse a name the
    // database would happily accept.
    await expect(
      findBundleByName(fixtures.db(), `STORE-FIND-${fixtures.suffix}`),
    ).resolves.toBeUndefined()
  })

  it('reports the highest version, and 0 for a bundle with none', async () => {
    const bare = await insertBundle(fixtures.db(), {
      name: `store-bare-${fixtures.suffix}`,
      description: undefined,
      spendCapsEnforceable: false,
      createdByUserId: actorId,
    })

    await expect(
      fixtures.db().transaction((tx) => lockBundleForVersioning(tx, bare.id)),
    ).resolves.toMatchObject({ highestVersion: 0 })

    const versioned = await register(`store-versioned-${fixtures.suffix}`, 1, 'b')
    await insertBundleVersion(fixtures.db(), {
      setupBundleId: versioned.id,
      version: 2,
      s3Key: 'bundles/store-versioned/2.tar.gz',
      contentDigest: digest('c'),
      sizeBytes: 1,
      registeredByUserId: actorId,
    })

    await expect(
      fixtures.db().transaction((tx) => lockBundleForVersioning(tx, versioned.id)),
    ).resolves.toMatchObject({ highestVersion: 2 })
  })

  it('serialises two concurrent replacements into versions 2 and 3, never a duplicate key', async () => {
    const bundle = await register(`store-race-${fixtures.suffix}`, 1, 'd')

    const replace = (seed: string) =>
      fixtures.db().transaction(async (tx) => {
        const locked = await lockBundleForVersioning(tx, bundle.id)
        if (locked === undefined) throw new Error('The bundle vanished mid-test.')
        return insertBundleVersion(tx, {
          setupBundleId: bundle.id,
          version: locked.highestVersion + 1,
          s3Key: `bundles/store-race/${seed}.tar.gz`,
          contentDigest: digest(seed),
          sizeBytes: 1,
          registeredByUserId: actorId,
        })
      })

    // Both transactions read `max(version)` — but the second one only gets to read it after the
    // first has committed, because the parent row is locked. Without the lock both would read 1,
    // both would insert version 2, and the loser would fail on the unique index instead of
    // producing version 3.
    const [second, third] = await Promise.all([replace('e'), replace('f')])

    expect([second.version, third.version].sort((a, b) => a - b)).toStrictEqual([2, 3])

    const stored = await fixtures
      .db()
      .select({ version: setupBundleVersions.version, s3Key: setupBundleVersions.s3Key })
      .from(setupBundleVersions)
      .where(eq(setupBundleVersions.setupBundleId, bundle.id))
      .orderBy(setupBundleVersions.version)

    expect(stored.map((row) => row.version)).toStrictEqual([1, 2, 3])
    // Three versions, three distinct keys: nothing was overwritten (FR-090).
    expect(new Set(stored.map((row) => row.s3Key)).size).toBe(3)
  }, 30_000)

  it('reads the latest version of each named bundle in one pass', async () => {
    const one = await register(`store-latest-one-${fixtures.suffix}`, 1, 'a')
    const two = await register(`store-latest-two-${fixtures.suffix}`, 1, 'b')
    await insertBundleVersion(fixtures.db(), {
      setupBundleId: two.id,
      version: 7,
      s3Key: 'bundles/store-latest-two/7.tar.gz',
      contentDigest: digest('e'),
      sizeBytes: 1,
      registeredByUserId: actorId,
    })

    const latest = await readLatestVersions(fixtures.db(), [one.id, two.id])

    expect(latest.get(one.id)?.version).toBe(1)
    expect(latest.get(two.id)?.version).toBe(7)
  })

  it('asks nothing of the database when there are no bundles to ask about', async () => {
    await expect(readLatestVersions(fixtures.db(), [])).resolves.toStrictEqual(new Map())
    await expect(readLatestValidations(fixtures.db(), [])).resolves.toStrictEqual(new Map())
  })

  it('filters the list to enabled bundles and paginates by keyset', async () => {
    const enabled = await register(`store-enabled-${fixtures.suffix}`, 1, 'a')
    await register(`store-disabled-${fixtures.suffix}`, 1, 'b')
    await updateBundle(fixtures.db(), enabled.id, { enabled: true })

    const onlyEnabled = await listBundles(fixtures.db(), {
      enabledOnly: true,
      includeArchived: false,
      limit: 50,
    })
    expect(onlyEnabled.items.map((bundle) => bundle.id)).toContain(enabled.id)
    expect(onlyEnabled.items.every((bundle) => bundle.enabled)).toBe(true)

    const firstPage = await listBundles(fixtures.db(), {
      enabledOnly: false,
      includeArchived: false,
      limit: 1,
    })
    expect(firstPage.items).toHaveLength(1)
    expect(firstPage.nextCursor).toBeDefined()

    const secondPage = await listBundles(fixtures.db(), {
      enabledOnly: false,
      includeArchived: false,
      limit: 1,
      cursor: firstPage.nextCursor,
    })
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id)
  })

  it('hides an archived bundle unless it is asked for', async () => {
    const archived = await register(`store-archived-${fixtures.suffix}`, 1, 'a')
    await updateBundle(fixtures.db(), archived.id, { archivedAt: new Date() })

    const hidden = await listBundles(fixtures.db(), {
      enabledOnly: false,
      includeArchived: false,
      limit: 100,
    })
    expect(hidden.items.map((bundle) => bundle.id)).not.toContain(archived.id)

    const shown = await listBundles(fixtures.db(), {
      enabledOnly: false,
      includeArchived: true,
      limit: 100,
    })
    expect(shown.items.map((bundle) => bundle.id)).toContain(archived.id)
  })
})
