import { randomUUID } from 'node:crypto'

import { inArray, or } from 'drizzle-orm'

import type { DatabaseClient, SisyphusDatabase } from '../../db'
import {
  configurationAudit,
  createDatabaseClient,
  roleChanges,
  setupBundles,
  setupBundleVersions,
  users,
  workflows,
  workspaces,
  workspaceVersions,
} from '../../db'
import { runMigrations } from '../../db/migrations'
import type { UserRole, WorkflowState } from '../../enums'

/**
 * **Test support for the live-database suites in this directory. Not production code.**
 *
 * It lives in `src/` because that is where the tests that import it live and where the type
 * checker and linter can see it — but nothing under `src/server/` imports it, and it must never be
 * re-exported from `src/server/index.ts`. Exporting it would put a fixture seeder one import away
 * from application code.
 *
 * ## Why each suite gets its own database
 *
 * The never-zero-active-admins invariant (FR-173) is **global**: it counts every active admin in
 * the database. A test that proves the last admin cannot be demoted therefore has to be able to
 * say what "the last admin" is — and it cannot, if another suite is concurrently seeding admins of
 * its own into the same database. Observed rather than hypothetical: sharing one database made
 * these tests fail intermittently against fixtures belonging to nobody in this directory.
 *
 * Filtering the count to this suite's own rows would be worse than the flakiness. The production
 * code counts every admin, so a test that counted a subset would be proving a different rule.
 *
 * So {@link UserFixtures.open} creates a database named after a random suffix and migrates it, and
 * {@link UserFixtures.close} drops it. Nothing outside it is read, written or deleted — which is
 * also what makes these suites safe to run against a server somebody else is using.
 *
 * ## Why it skips locally and fails in CI
 *
 * With `SISYPHUS_TEST_DATABASE_URL` unset on a developer machine, {@link readTestDatabaseUrl}
 * returns `undefined` and the caller turns its suite into `describe.skip`, so a plain `vitest run`
 * on a machine with no Postgres passes rather than erroring on connect.
 *
 * In CI that same silence is the failure mode this helper exists to prevent (FR-204, SC-064). A
 * database-backed test must not pass by not running: roughly a third of this feature's assertions
 * — the exactly-once unique index, the branch-lock advisory lock, the iteration `CHECK`, spend
 * scoping, the skill-digest readback — only execute against a real server, and a green pipeline
 * that skipped all of them is worse than a red one. So when `CI` is set and the variable is not,
 * {@link readTestDatabaseUrl} throws at module scope and the suite is reported as failed.
 */

/** The environment variable holding the live test database connection string. */
export const TEST_DATABASE_URL_VARIABLE = 'SISYPHUS_TEST_DATABASE_URL'

/** A promise and the call that settles it. See {@link createGate}. */
export interface Gate {
  /** Resolves once {@link Gate.open} has been called. */
  readonly opened: Promise<void>
  readonly open: () => void
}

/**
 * A promise plus its resolver, for holding a transaction open at a chosen moment.
 *
 * The one piece of machinery every concurrency test in this package needs: a transaction cannot be
 * paused from outside, so the test parks it on `await gate.opened` at the instant it cares about,
 * lets a second transaction commit, and only then releases it. Shared from here — rather than
 * redefined per suite — so "hold A open, land B, release A" is one idiom with one meaning.
 */
export const createGate = (): Gate => {
  let open = (): void => undefined
  const opened = new Promise<void>((resolve) => {
    open = () => {
      resolve()
    }
  })
  return { opened, open }
}

/** The environment variable every CI provider sets, and the local shell does not. */
export const CI_VARIABLE = 'CI'

/**
 * Whether this process is a CI run.
 *
 * `CI=false` and `CI=0` count as *not* CI: some tools export the variable unconditionally and
 * signal with its value, and reading those as CI would break `vitest run` for anyone whose shell
 * happens to have one of them set.
 */
const isContinuousIntegration = (
  environment: Readonly<Record<string, string | undefined>>,
): boolean => {
  const value = environment[CI_VARIABLE]?.trim().toLowerCase()
  return value !== undefined && value !== '' && value !== 'false' && value !== '0'
}

/** What a CI run without a database is told. Exported so the message itself can be asserted on. */
export const MISSING_TEST_DATABASE_MESSAGE =
  `${TEST_DATABASE_URL_VARIABLE} is not set, but ${CI_VARIABLE} is. ` +
  'The database-backed suites skip only on developer machines; in CI they are the point, and a ' +
  'suite that skips there reports success without having proved anything. Start a Postgres for ' +
  `the job and export ${TEST_DATABASE_URL_VARIABLE} — see the \`services:\` block in ` +
  '`.github/workflows/ci.yml`.'

/**
 * The connection string, `undefined` when the suite should skip, or a throw when it must not.
 *
 * A blank or whitespace-only value counts as absent: a variable exported as `''` in CI is a
 * misconfiguration, and connecting to `''` fails with an error about the URL rather than a message
 * saying the database was not configured.
 *
 * @param environment - Defaults to the process environment; injectable so this is testable.
 * @throws When the variable is absent and `CI` is set — see the module note above.
 */
export const readTestDatabaseUrl = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined => {
  const value = environment[TEST_DATABASE_URL_VARIABLE]?.trim()
  if (value === undefined || value === '') {
    if (isContinuousIntegration(environment)) {
      throw new Error(MISSING_TEST_DATABASE_MESSAGE)
    }
    return undefined
  }
  return value
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
  `sisyphus_users_${suffix.replace(/[^a-z0-9]/g, '')}`

export interface SeedUserOptions {
  /** Distinguishes fixtures within one suite; combined with the scope's random suffix. */
  readonly label: string
  readonly role?: UserRole
  readonly isActive?: boolean
}

export interface SeededUser {
  readonly id: string
  readonly email: string
}

export interface UserFixtures {
  /** The Drizzle handle. A function, because the database is created by {@link UserFixtures.open}. */
  readonly db: () => SisyphusDatabase
  /** The random per-scope suffix, for asserting on values the fixtures generated. */
  readonly suffix: string
  /** Create and migrate the scratch database. Call from `beforeAll` with a generous timeout. */
  readonly open: () => Promise<void>
  /** Drop the scratch database. Call from `afterAll`. */
  readonly close: () => Promise<void>
  readonly seedUser: (options: SeedUserOptions) => Promise<SeededUser>
  /**
   * A workflow owned by `ownerUserId`, with the bundle and workspace rows it cannot exist without.
   * Used to prove what deactivation does — and does not do — to a run in flight (FR-176).
   */
  readonly seedWorkflow: (options: {
    readonly ownerUserId: string
    readonly state: WorkflowState
  }) => Promise<string>
  /** Delete every row this scope created, children first. Call from `afterEach`. */
  readonly removeAll: () => Promise<void>
  /** Backends parked on a lock, for proving that a racing transaction really did wait. */
  readonly backendsWaitingOnLocks: () => Promise<number>
  /**
   * Backends sitting inside an open transaction, for proving that a gated one really is open.
   *
   * Asked of `pg_stat_activity` rather than inferred from an unsettled promise: a promise that has
   * not resolved says only that JavaScript has not continued, which a transaction that never began
   * would satisfy just as well. `idle in transaction` is Postgres itself confirming that a backend
   * holds an open transaction and is waiting on the client — which is precisely the state a
   * mid-run test needs its first transaction to be in while the second one commits.
   */
  readonly backendsInTransaction: () => Promise<number>
}

interface CreatedIds {
  readonly users: string[]
  readonly workflows: string[]
  readonly bundles: string[]
  readonly bundleVersions: string[]
  readonly workspaces: string[]
  readonly workspaceVersions: string[]
}

const emptyIds = (): CreatedIds => ({
  users: [],
  workflows: [],
  bundles: [],
  bundleVersions: [],
  workspaces: [],
  workspaceVersions: [],
})

/**
 * The first row, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this project, so `rows[0]` is typed as present even when the
 * result set is empty — and a `=== undefined` guard against it is narrowed away as unreachable.
 * Going through a function whose *declared* return type admits `undefined` restores the check.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** Pull the single id out of a `returning({ id })`, failing loudly rather than yielding `undefined`. */
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
export const createUserFixtures = (connectionString: string): UserFixtures => {
  const suffix = randomUUID().slice(0, 8)
  const databaseName = scratchDatabaseName(suffix)
  let client: DatabaseClient | undefined
  let created = emptyIds()

  const requireClient = (): DatabaseClient => {
    if (client === undefined) {
      throw new Error('The fixture scope was used before open() or after close().')
    }
    return client
  }

  /** Bundle and workspace versions are shared by every workflow this scope seeds. */
  let dependencies: { bundleVersionId: string; workspaceVersionId: string } | undefined

  const seedWorkflowDependencies = async (
    ownerUserId: string,
  ): Promise<{ bundleVersionId: string; workspaceVersionId: string }> => {
    if (dependencies !== undefined) {
      return dependencies
    }
    const db = requireClient().db

    const bundleId = requireId(
      await db
        .insert(setupBundles)
        .values({ name: `fixture-bundle-${suffix}`, createdByUserId: ownerUserId })
        .returning({ id: setupBundles.id }),
      'a setup bundle',
    )
    created.bundles.push(bundleId)

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
    created.bundleVersions.push(bundleVersionId)

    const workspaceId = requireId(
      await db
        .insert(workspaces)
        .values({ name: `fixture-workspace-${suffix}` })
        .returning({ id: workspaces.id }),
      'a workspace',
    )
    created.workspaces.push(workspaceId)

    const workspaceVersionId = requireId(
      await db
        .insert(workspaceVersions)
        .values({ workspaceId, version: 1, createdByUserId: ownerUserId })
        .returning({ id: workspaceVersions.id }),
      'a workspace version',
    )
    created.workspaceVersions.push(workspaceVersionId)

    dependencies = { bundleVersionId, workspaceVersionId }
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
      client = createDatabaseClient({ connectionString: scratch })
    },

    close: async () => {
      await client?.close()
      client = undefined
      await onServer(`drop database if exists ${databaseName} with (force)`)
    },

    seedUser: async (options) => {
      const email = `${suffix}-${options.label}@sisyphus.test`
      const rows = await requireClient()
        .db.insert(users)
        .values({
          email,
          googleSubject: `${suffix}-${options.label}`,
          displayName: `Fixture ${options.label}`,
          role: options.role ?? 'engineer',
          isActive: options.isActive ?? true,
        })
        .returning({ id: users.id })

      const id = requireId(rows, 'a fixture user')
      created.users.push(id)
      return { id, email }
    },

    seedWorkflow: async ({ ownerUserId, state }) => {
      const { bundleVersionId, workspaceVersionId } = await seedWorkflowDependencies(ownerUserId)
      const id = requireId(
        await requireClient()
          .db.insert(workflows)
          .values({
            type: 'delegated',
            state,
            ownerUserId,
            setupBundleVersionId: bundleVersionId,
            workspaceVersionId,
            model: 'claude-sonnet-5',
            instanceType: 'fixture.small',
            purchaseMode: 'on_demand',
            sessionId: randomUUID(),
          })
          .returning({ id: workflows.id }),
        'a fixture workflow',
      )
      created.workflows.push(id)
      return id
    },

    removeAll: async () => {
      const db = requireClient().db

      if (created.workflows.length > 0) {
        await db.delete(workflows).where(inArray(workflows.id, created.workflows))
      }
      if (created.users.length > 0) {
        // Both columns reference `users`, and either one alone would leave a row that blocks the
        // delete below with a foreign-key violation rather than a useful message.
        await db
          .delete(configurationAudit)
          .where(
            or(
              inArray(configurationAudit.actorUserId, created.users),
              inArray(configurationAudit.entityId, created.users),
            ),
          )
        await db
          .delete(roleChanges)
          .where(
            or(
              inArray(roleChanges.actorUserId, created.users),
              inArray(roleChanges.subjectUserId, created.users),
            ),
          )
      }
      if (created.bundleVersions.length > 0) {
        await db
          .delete(setupBundleVersions)
          .where(inArray(setupBundleVersions.id, created.bundleVersions))
      }
      if (created.bundles.length > 0) {
        await db.delete(setupBundles).where(inArray(setupBundles.id, created.bundles))
      }
      if (created.workspaceVersions.length > 0) {
        await db
          .delete(workspaceVersions)
          .where(inArray(workspaceVersions.id, created.workspaceVersions))
      }
      if (created.workspaces.length > 0) {
        await db.delete(workspaces).where(inArray(workspaces.id, created.workspaces))
      }
      if (created.users.length > 0) {
        await db.delete(users).where(inArray(users.id, created.users))
      }

      dependencies = undefined
      created = emptyIds()
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

    backendsInTransaction: async () => {
      const rows = await requireClient().sql<{ held: number }[]>`
        select count(*)::int as held
          from pg_stat_activity
         where datname = current_database()
           and state = 'idle in transaction'`
      return firstRow(rows)?.held ?? 0
    },
  }
}
