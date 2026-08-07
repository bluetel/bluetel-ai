import { randomUUID } from 'node:crypto'

import type {
  DatabaseClient,
  Notification,
  SisyphusDatabase,
  Workflow,
} from '@bluetel-ai/sisyphus-api/db'
import {
  createDatabaseClient,
  notificationPreferences,
  notifications,
  setupBundles,
  setupBundleVersions,
  users,
  workflows,
  workflowWatchers,
  workspaces,
  workspaceVersions,
} from '@bluetel-ai/sisyphus-api/db'
import { runMigrations } from '@bluetel-ai/sisyphus-api/db/migrations'
import { asc, eq } from 'drizzle-orm'

/**
 * **Test support for the live-database notify suites. Not production code.**
 *
 * It lives in `src/` because that is where the tests that import it live and where the type checker
 * and linter can see it — but no production module in this package imports it, and it is
 * deliberately **not** re-exported from `./index.ts`, exactly as the control plane's
 * `jobs/workflow-fixtures.ts` is kept out of its `jobs/index.ts`. Exporting it would put a fixture
 * seeder one import away from the delivery path.
 *
 * Each suite gets its own scratch database, created and migrated by {@link NotifyFixtures.open} and
 * dropped by {@link NotifyFixtures.close}, which is what makes these suites safe to run against a
 * server somebody else is using. The approach is the one
 * `packages/sisyphus-api/src/server/admin/test-database.ts` established.
 *
 * With `SISYPHUS_TEST_DATABASE_URL` unset, {@link readTestDatabaseUrl} returns `undefined` and the
 * caller turns its suite into `describe.skip`, so a plain `vitest run` on a machine with no Postgres
 * passes rather than erroring on connect.
 *
 * **No Slack token appears anywhere here.** The `slack_user_id` values are obvious fixtures, and
 * the only Slack these suites talk to is the recording fake in `./slack-fake.ts`.
 */

/** The environment variable holding the live test database connection string. */
export const TEST_DATABASE_URL_VARIABLE = 'SISYPHUS_TEST_DATABASE_URL'

/**
 * The connection string, or `undefined` when the suite should skip.
 *
 * A blank or whitespace-only value counts as absent: a variable exported as `''` in CI is a
 * misconfiguration, and connecting to `''` fails with an error about the URL rather than one saying
 * the database was not configured.
 *
 * @param environment - Defaults to the process environment; injectable so this is testable.
 */
export const readTestDatabaseUrl = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined => {
  const value = environment[TEST_DATABASE_URL_VARIABLE]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/** Point a connection string at a different database on the same server. */
export const withDatabaseName = (connectionString: string, databaseName: string): string => {
  const url = new URL(connectionString)
  url.pathname = `/${databaseName}`
  return url.toString()
}

/** A scratch database name derived from a suffix. Lower-case and alphanumeric, so never quoted. */
export const scratchDatabaseName = (suffix: string): string =>
  `sisyphus_notify_${suffix.replace(/[^a-z0-9]/g, '')}`

export interface SeedNotifyUserOptions {
  readonly label: string
  /** Null models FR-140's unnotifiable user: a real account with no Slack identity. */
  readonly slackUserId?: string | null
  readonly isActive?: boolean
}

export interface NotifyFixtures {
  readonly db: () => SisyphusDatabase
  readonly suffix: string
  /** The workspace name every seeded run belongs to, for asserting FR-137's workspace line. */
  readonly workspaceName: string
  readonly open: () => Promise<void>
  readonly close: () => Promise<void>
  readonly seedUser: (options: SeedNotifyUserOptions) => Promise<string>
  readonly seedWorkflow: (options: {
    readonly ownerUserId: string
    readonly state?: Workflow['state']
    readonly ticketReference?: string
  }) => Promise<string>
  readonly addWatcher: (input: {
    readonly workflowId: string
    readonly userId: string
  }) => Promise<void>
  readonly setPreference: (input: {
    readonly userId: string
    readonly event: Notification['event']
    readonly enabled: boolean
  }) => Promise<void>
  /** The whole workflow row, for the FR-141 before-and-after comparison. */
  readonly readWorkflow: (workflowId: string) => Promise<Workflow | undefined>
  /** Every notification recorded, oldest first. */
  readonly readNotifications: () => Promise<readonly Notification[]>
}

/** See the API package's fixtures: `noUncheckedIndexedAccess` is off, so indexing needs this. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

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
 *   it is `undefined`.
 */
export const createNotifyFixtures = (connectionString: string): NotifyFixtures => {
  const suffix = randomUUID().slice(0, 8)
  const databaseName = scratchDatabaseName(suffix)
  const workspaceName = `notify-workspace-${suffix}`
  let client: DatabaseClient | undefined

  const requireClient = (): DatabaseClient => {
    if (client === undefined) {
      throw new Error('The fixture scope was used before open() or after close().')
    }
    return client
  }

  /** Bundle and workspace versions shared by every workflow this scope seeds. */
  let dependencies: { bundleVersionId: string; workspaceVersionId: string } | undefined

  const seedDependencies = async (
    ownerUserId: string,
  ): Promise<{ bundleVersionId: string; workspaceVersionId: string }> => {
    if (dependencies !== undefined) {
      return dependencies
    }
    const db = requireClient().db

    const bundleId = requireId(
      await db
        .insert(setupBundles)
        .values({ name: `notify-bundle-${suffix}`, createdByUserId: ownerUserId })
        .returning({ id: setupBundles.id }),
      'a setup bundle',
    )

    const bundleVersionId = requireId(
      await db
        .insert(setupBundleVersions)
        .values({
          setupBundleId: bundleId,
          version: 1,
          s3Key: `fixtures/${suffix}.tar.zst`,
          contentDigest: `sha256:${suffix}`,
          sizeBytes: 1,
          registeredByUserId: ownerUserId,
        })
        .returning({ id: setupBundleVersions.id }),
      'a setup bundle version',
    )

    const workspaceId = requireId(
      await db.insert(workspaces).values({ name: workspaceName }).returning({ id: workspaces.id }),
      'a workspace',
    )

    const workspaceVersionId = requireId(
      await db
        .insert(workspaceVersions)
        .values({ workspaceId, version: 1, createdByUserId: ownerUserId })
        .returning({ id: workspaceVersions.id }),
      'a workspace version',
    )

    dependencies = { bundleVersionId, workspaceVersionId }
    return dependencies
  }

  /** `create`/`drop database` cannot run in a transaction or against the database in question. */
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
    workspaceName,

    open: async () => {
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

    seedUser: async (options) =>
      requireId(
        await requireClient()
          .db.insert(users)
          .values({
            email: `${suffix}-${options.label}@sisyphus.test`,
            googleSubject: `${suffix}-${options.label}`,
            displayName: `Fixture ${options.label}`,
            role: 'engineer',
            isActive: options.isActive ?? true,
            // A fixture value, never a real identifier. Undefined means "give them one".
            slackUserId:
              options.slackUserId === undefined
                ? `slack-fixture-${options.label}`
                : options.slackUserId,
          })
          .returning({ id: users.id }),
        'a fixture user',
      ),

    seedWorkflow: async ({ ownerUserId, state, ticketReference }) => {
      const { bundleVersionId, workspaceVersionId } = await seedDependencies(ownerUserId)

      return requireId(
        await requireClient()
          .db.insert(workflows)
          .values({
            type: 'delegated',
            state: state ?? 'succeeded',
            terminalOutcome: state === undefined || state === 'succeeded' ? 'succeeded' : null,
            outcomeReason: 'All checks passed.',
            ownerUserId,
            initiatedByUserId: ownerUserId,
            setupBundleVersionId: bundleVersionId,
            workspaceVersionId,
            ticketReference: ticketReference ?? `NOTIFY-${suffix}`,
            assembledPrompt: 'Fixture prompt.',
            model: 'claude-sonnet-5',
            instanceType: 'fixture.small',
            purchaseMode: 'spot',
            turnCap: 40,
            spendCap: '25.0000',
            turnsUsed: 4,
            spendUsed: '3.5000',
            sessionId: randomUUID(),
          })
          .returning({ id: workflows.id }),
        'a fixture workflow',
      )
    },

    addWatcher: async ({ workflowId, userId }) => {
      await requireClient().db.insert(workflowWatchers).values({ workflowId, userId })
    },

    setPreference: async ({ userId, event, enabled }) => {
      await requireClient().db.insert(notificationPreferences).values({ userId, event, enabled })
    },

    readWorkflow: async (workflowId) =>
      firstRow(
        await requireClient().db.select().from(workflows).where(eq(workflows.id, workflowId)),
      ),

    readNotifications: async () =>
      requireClient().db.select().from(notifications).orderBy(asc(notifications.createdAt)),
  }
}
