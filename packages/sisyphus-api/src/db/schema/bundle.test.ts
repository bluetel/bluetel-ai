import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { UserFixtures } from '../../server/admin/test-database'
import { createUserFixtures, readTestDatabaseUrl } from '../../server/admin/test-database'

import { setupBundles, setupBundleVersions, validationCredentials, validationRuns } from './bundle'
import { columnOf, describeTable, indexOf, referencedTables } from './introspect'
import { scopedCredentials } from './supervision'

describe('setup_bundles', () => {
  it('is disabled until an admin enables it (FR-167, FR-168)', () => {
    expect(columnOf(setupBundles, 'enabled').defaultValue).toBe(false)
    expect(columnOf(setupBundles, 'enabled').notNull).toBe(true)
  })

  it('records whether spend caps can actually be enforced (FR-093)', () => {
    expect(columnOf(setupBundles, 'spend_caps_enforceable').defaultValue).toBe(false)
    expect(columnOf(setupBundles, 'spend_caps_enforceable').notNull).toBe(true)
  })

  it('archives rather than deletes, because history references it (FR-092)', () => {
    expect(columnOf(setupBundles, 'archived_at').notNull).toBe(false)
    expect(describeTable(setupBundles).columns.map((column) => column.name)).not.toContain(
      'deleted_at',
    )
  })

  it('has a unique name', () => {
    expect(indexOf(setupBundles, 'setup_bundles_name_key').unique).toBe(true)
  })

  it('holds no archive location itself — a bundle is its versions', () => {
    const names = describeTable(setupBundles).columns.map((column) => column.name)
    expect(names).not.toContain('s3_key')
    expect(names).not.toContain('content_digest')
  })
})

describe('setup_bundle_versions', () => {
  it('is immutable: it has created_at and no updated_at (FR-090)', () => {
    const names = describeTable(setupBundleVersions).columns.map((column) => column.name)
    expect(names).toContain('created_at')
    expect(names).not.toContain('updated_at')
  })

  it('numbers versions uniquely within a bundle', () => {
    const index = indexOf(setupBundleVersions, 'setup_bundle_versions_version_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['setup_bundle_id', 'version'])
  })

  it('carries the digest that makes immutability checkable rather than asserted', () => {
    expect(columnOf(setupBundleVersions, 'content_digest').notNull).toBe(true)
    expect(columnOf(setupBundleVersions, 's3_key').notNull).toBe(true)
    expect(columnOf(setupBundleVersions, 'size_bytes').type).toBe('bigint')
  })

  it('records who registered it', () => {
    expect(columnOf(setupBundleVersions, 'registered_by_user_id').notNull).toBe(true)
    expect([...referencedTables(setupBundleVersions)].sort()).toStrictEqual([
      'setup_bundles',
      'users',
    ])
  })
})

describe('validation_runs', () => {
  it('proves a bundle version, not a bundle (FR-147, FR-148)', () => {
    expect(columnOf(validationRuns, 'setup_bundle_version_id').notNull).toBe(true)
    expect(referencedTables(validationRuns)).toContain('setup_bundle_versions')
  })

  it('leaves outcome and end time null while the run is in flight', () => {
    expect(columnOf(validationRuns, 'outcome').notNull).toBe(false)
    expect(columnOf(validationRuns, 'ended_at').notNull).toBe(false)
    expect(columnOf(validationRuns, 'started_at').notNull).toBe(true)
  })

  it('records per-phase results, so a failure names the phase that failed', () => {
    expect(columnOf(validationRuns, 'phase_results').type).toBe('jsonb')
    expect(columnOf(validationRuns, 'output_s3_key').notNull).toBe(false)
  })

  it('attributes the run to whoever triggered it', () => {
    expect(columnOf(validationRuns, 'triggered_by_user_id').notNull).toBe(true)
  })
})

describe('validation_credentials', () => {
  it('binds the credential to one validation run and to no workflow (T200, FR-147)', () => {
    // The whole design decision, stated as a shape. A validation credential that could name a
    // workflow would be able to satisfy a `machineProcedure`, which is exactly what the separate
    // table exists to make impossible.
    expect(columnOf(validationCredentials, 'validation_run_id').notNull).toBe(true)
    expect(referencedTables(validationCredentials)).toStrictEqual(['validation_runs'])
    expect(describeTable(validationCredentials).columns.map((column) => column.name)).not.toContain(
      'workflow_id',
    )
  })

  it('reaches nothing in the agent credential pool (003/FR-052)', () => {
    // Proving a bundle must not consume pool capacity. The way that is held is that there is no
    // column here through which a validation could take a seat.
    const names = describeTable(validationCredentials).columns.map((column) => column.name)
    for (const forbidden of ['agent_credential_id', 'credential_group_id', 'lease_id', 'fence']) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('makes a replayed token recognisable, as the workflow table does', () => {
    expect(indexOf(validationCredentials, 'validation_credentials_jti_key').unique).toBe(true)
    expect(columnOf(validationCredentials, 'jti').notNull).toBe(true)
  })

  it('allows one live credential per validation run, revocation being a timestamp', () => {
    const index = indexOf(validationCredentials, 'validation_credentials_live_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['validation_run_id'])
    expect(index.where).toBe('"validation_credentials"."revoked_at" is null')
  })

  it('requires an expiry and counts renewals', () => {
    expect(columnOf(validationCredentials, 'expires_at').notNull).toBe(true)
    expect(columnOf(validationCredentials, 'renewal_count').defaultValue).toBe(0)
  })
})

// --- Against a real database ----------------------------------------------------------------

/**
 * **The two live-credential indexes, proved by Postgres rather than by Drizzle's metadata.**
 *
 * Every assertion above this line reads Drizzle's own metadata, which answers "is this index
 * declared" on a laptop with no database. That is worth having and it is **not** what these tests
 * claim. A metadata assertion passes just as happily when the migration that would have created the
 * index is missing or wrong, which is a real failure mode in this repository rather than a
 * hypothetical one — PR #19's review found a uniqueness test that went on passing with its index
 * dropped.
 *
 * So the claim being made here is about what Postgres does when a second live credential is
 * inserted, and only Postgres can settle it. The suite skips when `SISYPHUS_TEST_DATABASE_URL` is
 * unset and fails in CI when it is — see `server/admin/test-database.ts` for why that asymmetry
 * exists.
 *
 * `scoped_credentials_live_key` is exercised here alongside the new one deliberately. T200 did not
 * touch it, and the point of testing it in the same file is that "did not touch it" becomes a thing
 * this suite would notice rather than a claim in a comment.
 */

const connectionString = readTestDatabaseUrl()

/**
 * The name of the index a write was refused by.
 *
 * Asserted on rather than the error message: Drizzle wraps the driver error in one whose `message`
 * is the failing SQL, so `toThrow(/…_live_key/)` would pass on any insert that failed for any reason
 * at all — including the null violation or missing foreign key a *dropped* index would produce
 * nothing of. `constraint_name` comes from Postgres and names the exact index that rejected the row.
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

describe.skipIf(connectionString === undefined)(
  'one live credential per subject, against Postgres',
  () => {
    // Narrowed once: `describe.skipIf` has already decided, but TypeScript has not seen it.
    const fixtures: UserFixtures = createUserFixtures(connectionString ?? '')
    let ownerId = ''
    let bundleVersionId = ''
    let workflowId = ''

    const seedValidationRun = async (): Promise<string> => {
      const [row] = await fixtures
        .db()
        .insert(validationRuns)
        .values({ setupBundleVersionId: bundleVersionId, triggeredByUserId: ownerId })
        .returning({ id: validationRuns.id })
      return row.id
    }

    /** One mint, as the control plane would write it: a live credential naming a run. */
    const mint = async (validationRunId: string): Promise<string> => {
      const [row] = await fixtures
        .db()
        .insert(validationCredentials)
        .values({
          validationRunId,
          jti: randomUUID(),
          expiresAt: new Date(Date.now() + 900_000),
        })
        .returning({ id: validationCredentials.id })
      return row.id
    }

    beforeAll(async () => {
      await fixtures.open()
      const owner = await fixtures.seedUser({ label: 'validation-owner', role: 'admin' })
      ownerId = owner.id
      // `seedWorkflow` is what creates the bundle and workspace rows this scope shares, and the
      // workflow it returns is also the subject of the `scoped_credentials` half below.
      workflowId = await fixtures.seedWorkflow({ ownerUserId: ownerId, state: 'running' })

      const [version] = await fixtures
        .db()
        .select({ id: setupBundleVersions.id })
        .from(setupBundleVersions)
        .limit(1)
      bundleVersionId = version.id
    }, 120_000)

    afterAll(async () => {
      await fixtures.close()
    })

    afterEach(async () => {
      await fixtures.db().delete(validationCredentials)
      await fixtures.db().delete(validationRuns)
      await fixtures.db().delete(scopedCredentials)
    })

    it('refuses a second live credential for one validation run (T200)', async () => {
      const validationRunId = await seedValidationRun()
      await mint(validationRunId)

      await expect(refusedBy(async () => mint(validationRunId))).resolves.toBe(
        'validation_credentials_live_key',
      )
    })

    it('refuses a second live credential for one workflow, unchanged by T200', async () => {
      // `scoped_credentials_live_key` as it was before this change and as it must remain. A
      // validation credential lives in a different table precisely so this index never had to be
      // reworked to accommodate a row with no workflow.
      const live = async (): Promise<unknown> =>
        fixtures
          .db()
          .insert(scopedCredentials)
          .values({ workflowId, jti: randomUUID(), expiresAt: new Date(Date.now() + 900_000) })

      await live()

      await expect(refusedBy(live)).resolves.toBe('scoped_credentials_live_key')
    })

    it('frees the run once the incumbent is revoked, which is what a re-mint depends on', async () => {
      // The index would be a correctness bug in the other direction if it did not: a re-provision
      // revokes the incumbent inside its transaction and inserts a replacement.
      const validationRunId = await seedValidationRun()
      const first = await mint(validationRunId)

      await fixtures
        .db()
        .update(validationCredentials)
        .set({ revokedAt: new Date() })
        .where(eq(validationCredentials.id, first))

      await expect(mint(validationRunId)).resolves.toBeTypeOf('string')
    })

    it('lets two different validation runs each hold a live credential', async () => {
      // The complement of the first test, and the thing a *plain* unique index would have broken.
      const one = await seedValidationRun()
      const two = await seedValidationRun()

      await expect(mint(one)).resolves.toBeTypeOf('string')
      await expect(mint(two)).resolves.toBeTypeOf('string')
    })

    it('refuses a duplicate jti even across different runs', async () => {
      const one = await seedValidationRun()
      const two = await seedValidationRun()
      const jti = randomUUID()

      const withJti = async (validationRunId: string): Promise<unknown> =>
        fixtures
          .db()
          .insert(validationCredentials)
          .values({ validationRunId, jti, expiresAt: new Date(Date.now() + 900_000) })

      await withJti(one)

      await expect(refusedBy(async () => withJti(two))).resolves.toBe(
        'validation_credentials_jti_key',
      )
    })

    it('refuses a credential naming a validation run that does not exist', async () => {
      // The foreign key is what makes `ctx.validationRunId` a run rather than a string.
      await expect(refusedBy(async () => mint(randomUUID()))).resolves.toContain(
        'validation_credentials_validation_run_id',
      )
    })
  },
)
