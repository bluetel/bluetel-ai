import { randomUUID } from 'node:crypto'

import type {
  ComputeLease,
  DatabaseClient,
  SisyphusDatabase,
  Workflow,
} from '@bluetel-ai/sisyphus-api/db'
import {
  computeLeases,
  createDatabaseClient,
  setupBundles,
  setupBundleVersions,
  users,
  workflows,
  workspaces,
  workspaceVersions,
} from '@bluetel-ai/sisyphus-api/db'
import { runMigrations } from '@bluetel-ai/sisyphus-api/db/migrations'
import { count, eq, isNull } from 'drizzle-orm'

/**
 * **Test support for the live-database suites in this directory. Not production code.**
 *
 * It lives in `src/` because that is where the tests that import it live and where the type checker
 * and linter can see it — but nothing under `src/jobs/` imports it outside a `.test.ts`, and it is
 * deliberately **not** re-exported from `src/jobs/index.ts`. Exporting it would put a fixture
 * seeder one import away from a job.
 *
 * ## Why each suite gets its own database
 *
 * The admission ceiling is **global**: it counts every unreleased lease in the database. A test
 * that proves two concurrent admissions cannot both take the last slot has to be able to say what
 * "the last slot" is, and it cannot if another suite is concurrently seeding leases of its own.
 * Filtering the count to this suite's rows would be worse than the flakiness, because the
 * production code counts every lease and a test that counted a subset would be proving a different
 * rule.
 *
 * So {@link WorkflowFixtures.open} creates a database named after a random suffix and migrates it,
 * and {@link WorkflowFixtures.close} drops it. Nothing outside it is read, written or deleted,
 * which is also what makes these suites safe to run against a server somebody else is using. The
 * approach is the one `packages/sisyphus-api/src/server/admin/test-database.ts` established.
 *
 * ## Why it skips rather than fails
 *
 * With `SISYPHUS_TEST_DATABASE_URL` unset, {@link readTestDatabaseUrl} returns `undefined` and the
 * caller turns its suite into `describe.skip`, so a plain `vitest run` on a machine with no
 * Postgres passes rather than erroring on connect.
 */

/** The environment variable holding the live test database connection string. */
export const TEST_DATABASE_URL_VARIABLE = 'SISYPHUS_TEST_DATABASE_URL'

/**
 * The connection string, or `undefined` when the suite should skip.
 *
 * A blank or whitespace-only value counts as absent: a variable exported as `''` in CI is a
 * misconfiguration, and connecting to `''` fails with an error about the URL rather than one
 * saying the database was not configured.
 *
 * @param environment - Defaults to the process environment; injectable so this is testable.
 */
export const readTestDatabaseUrl = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined => {
  const value = environment[TEST_DATABASE_URL_VARIABLE]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * Point a connection string at a different database on the same server.
 *
 * @param connectionString - The suite's configured URL.
 * @param databaseName - The scratch database to address instead.
 */
export const withDatabaseName = (connectionString: string, databaseName: string): string => {
  const url = new URL(connectionString)
  url.pathname = `/${databaseName}`
  return url.toString()
}

/** A scratch database name derived from a suffix. Lower-case and alphanumeric, so never quoted. */
export const scratchDatabaseName = (suffix: string): string =>
  `sisyphus_control_plane_${suffix.replace(/[^a-z0-9]/g, '')}`

export interface SeedWorkflowOptions {
  /** Distinguishes fixtures within one suite; combined with the scope's random suffix. */
  readonly label: string
  readonly state?: Workflow['state']
  /** Set explicitly where a test asserts on queue order, so ordering is data rather than timing. */
  readonly createdAt?: Date
  readonly instanceType?: string
  readonly purchaseMode?: ComputeLease['purchaseMode']
}

export interface WorkflowFixtures {
  /** The Drizzle handle. A function, because the database is created by {@link WorkflowFixtures.open}. */
  readonly db: () => SisyphusDatabase
  /** The random per-scope suffix, for asserting on values the fixtures generated. */
  readonly suffix: string
  /** Create and migrate the scratch database. Call from `beforeAll` with a generous timeout. */
  readonly open: () => Promise<void>
  /** Drop the scratch database. Call from `afterAll`. */
  readonly close: () => Promise<void>
  /** A workflow with the user, bundle and workspace rows it cannot exist without. */
  readonly seedWorkflow: (options: SeedWorkflowOptions) => Promise<string>
  /** A live lease against a workflow, as provisioning would leave it. */
  readonly seedLease: (workflowId: string) => Promise<string>
  /** Release a lease, as teardown or the reconciler would. */
  readonly releaseLease: (leaseId: string) => Promise<void>
  /** Unreleased leases platform-wide — the number the ceiling is compared against. */
  readonly countLiveLeases: () => Promise<number>
  /** Leases ever taken for one workflow, released or not. FR-078 says this never exceeds one. */
  readonly countLeasesFor: (workflowId: string) => Promise<number>
  readonly stateOf: (workflowId: string) => Promise<Workflow['state'] | undefined>
  /** Delete every row this scope created. Call from `afterEach`. */
  readonly removeAll: () => Promise<void>
  /** Backends parked on a lock, for proving that a racing transaction really did wait. */
  readonly backendsWaitingOnLocks: () => Promise<number>
}

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** Pull the single id out of a `returning({ id })`, failing loudly rather than yielding undefined. */
const requireId = (rows: readonly { readonly id: string }[], what: string): string => {
  const id = firstRow(rows)?.id
  if (id === undefined) {
    throw new Error(`Seeding ${what} returned no row.`)
  }
  return id
}

/**
 * Build a fixture scope over a private, freshly-migrated database.
 *
 * @param connectionString - From {@link readTestDatabaseUrl}. The caller has already skipped when
 *   it is `undefined`, so this never has to decide what to do without one.
 */
export const createWorkflowFixtures = (connectionString: string): WorkflowFixtures => {
  const suffix = randomUUID().slice(0, 8)
  const databaseName = scratchDatabaseName(suffix)
  let client: DatabaseClient | undefined

  const requireClient = (): DatabaseClient => {
    if (client === undefined) {
      throw new Error('The fixture scope was used before open() or after close().')
    }
    return client
  }

  /** One owner, bundle version and workspace version shared by every workflow this scope seeds. */
  let dependencies:
    | { ownerUserId: string; bundleVersionId: string; workspaceVersionId: string }
    | undefined

  const seedDependencies = async (): Promise<{
    ownerUserId: string
    bundleVersionId: string
    workspaceVersionId: string
  }> => {
    if (dependencies !== undefined) {
      return dependencies
    }
    const db = requireClient().db

    const ownerUserId = requireId(
      await db
        .insert(users)
        .values({
          email: `${suffix}-owner@sisyphus.test`,
          googleSubject: `${suffix}-owner`,
          displayName: 'Fixture owner',
          role: 'engineer',
        })
        .returning({ id: users.id }),
      'a fixture user',
    )

    const bundleId = requireId(
      await db
        .insert(setupBundles)
        .values({ name: `fixture-bundle-${suffix}`, createdByUserId: ownerUserId })
        .returning({ id: setupBundles.id }),
      'a setup bundle',
    )

    const bundleVersionId = requireId(
      await db
        .insert(setupBundleVersions)
        .values({
          setupBundleId: bundleId,
          version: 1,
          s3Key: `fixtures/${suffix}.tar.gz`,
          contentDigest: `sha256:${suffix}`,
          sizeBytes: 1,
          registeredByUserId: ownerUserId,
        })
        .returning({ id: setupBundleVersions.id }),
      'a setup bundle version',
    )

    const workspaceId = requireId(
      await db
        .insert(workspaces)
        .values({ name: `fixture-workspace-${suffix}` })
        .returning({ id: workspaces.id }),
      'a workspace',
    )

    const workspaceVersionId = requireId(
      await db
        .insert(workspaceVersions)
        .values({ workspaceId, version: 1, createdByUserId: ownerUserId })
        .returning({ id: workspaceVersions.id }),
      'a workspace version',
    )

    dependencies = { ownerUserId, bundleVersionId, workspaceVersionId }
    return dependencies
  }

  /**
   * Run one statement against the configured database, for `create`/`drop database` — neither of
   * which can run inside a transaction or against the database being created or dropped.
   */
  const onServer = async (statement: string): Promise<void> => {
    const admin = createDatabaseClient({ connectionString, maxConnections: 1 })
    try {
      await admin.sql.unsafe(statement)
    } finally {
      await admin.close()
    }
  }

  return {
    db: () => requireClient().db,
    suffix,

    open: async () => {
      // `drop … if exists` first, so a run killed before its `close` cannot poison the next one.
      await onServer(`drop database if exists ${databaseName} with (force)`)
      await onServer(`create database ${databaseName}`)
      const scratch = withDatabaseName(connectionString, databaseName)
      await runMigrations({ connectionString: scratch })
      // More than the default: the concurrency tests hold one transaction open while a second
      // waits on its lock, and a pool of one would deadlock on the connection rather than on the
      // lock the test is about.
      client = createDatabaseClient({ connectionString: scratch, maxConnections: 10 })
    },

    close: async () => {
      await client?.close()
      client = undefined
      await onServer(`drop database if exists ${databaseName} with (force)`)
    },

    seedWorkflow: async (options) => {
      const { ownerUserId, bundleVersionId, workspaceVersionId } = await seedDependencies()

      return requireId(
        await requireClient()
          .db.insert(workflows)
          .values({
            type: 'delegated',
            state: options.state ?? 'queued',
            ownerUserId,
            setupBundleVersionId: bundleVersionId,
            workspaceVersionId,
            assembledPrompt: `Fixture prompt ${options.label}`,
            model: 'claude-sonnet-5',
            instanceType: options.instanceType ?? 'fixture.small',
            purchaseMode: options.purchaseMode ?? 'spot',
            sessionId: randomUUID(),
            ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
          })
          .returning({ id: workflows.id }),
        'a fixture workflow',
      )
    },

    seedLease: async (workflowId) =>
      requireId(
        await requireClient()
          .db.insert(computeLeases)
          .values({ workflowId, instanceType: 'fixture.small', purchaseMode: 'spot' })
          .returning({ id: computeLeases.id }),
        'a fixture compute lease',
      ),

    releaseLease: async (leaseId) => {
      await requireClient()
        .db.update(computeLeases)
        .set({ releasedAt: new Date(), releaseReason: 'fixture release' })
        .where(eq(computeLeases.id, leaseId))
    },

    countLiveLeases: async () => {
      const rows = await requireClient()
        .db.select({ value: count() })
        .from(computeLeases)
        .where(isNull(computeLeases.releasedAt))
      return firstRow(rows)?.value ?? 0
    },

    countLeasesFor: async (workflowId) => {
      const rows = await requireClient()
        .db.select({ value: count() })
        .from(computeLeases)
        .where(eq(computeLeases.workflowId, workflowId))
      return firstRow(rows)?.value ?? 0
    },

    stateOf: async (workflowId) => {
      const rows = await requireClient()
        .db.select({ state: workflows.state })
        .from(workflows)
        .where(eq(workflows.id, workflowId))
      return firstRow(rows)?.state
    },

    removeAll: async () => {
      // Cascading from the three roots clears the workflow, lease, event, bundle and workspace rows
      // without this fixture having to restate the foreign-key graph — and it is safe only because
      // the database is private to this suite.
      await requireClient().sql.unsafe(
        'truncate table users, workspaces, setup_bundles restart identity cascade',
      )
      dependencies = undefined
    },

    backendsWaitingOnLocks: async () => {
      /* cspell:ignore datname */
      const rows = await requireClient().sql<{ blocked: number }[]>`
        select count(*)::int as blocked
          from pg_stat_activity
         where datname = current_database()
           and wait_event_type = 'Lock'
           and state = 'active'`
      return firstRow(rows)?.blocked ?? 0
    },
  }
}
