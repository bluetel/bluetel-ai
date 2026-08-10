import { randomUUID } from 'node:crypto'

import type {
  AgentCredential,
  ConfigurationAuditEntry,
  CredentialLease,
  DatabaseClient,
  KeepAliveRun,
  SisyphusDatabase,
  Workflow,
} from '@bluetel-ai/sisyphus-api/db'
import {
  agentCredentials,
  configurationAudit,
  createDatabaseClient,
  credentialGroups,
  credentialLeases,
  executionProfiles,
  keepAliveRuns,
  profileCredentialGroups,
  setupBundles,
  setupBundleVersions,
  users,
  workflows,
  workspaces,
  workspaceVersions,
} from '@bluetel-ai/sisyphus-api/db'
import { runMigrations } from '@bluetel-ai/sisyphus-api/db/migrations'
import { and, asc, eq, isNull } from 'drizzle-orm'

/**
 * **Test support for the live-database suites in `allocate/` and `lease/`. Not production code.**
 *
 * It lives in `src/` because that is where the tests that import it live and where the type checker
 * and the linter can see it — but nothing outside a `.test.ts` imports it, and it is deliberately
 * **not** re-exported from `./index.ts`. `index.test.ts` asserts that absence, because a fixture
 * seeder one import away from the allocator is exactly the kind of thing that ends up called from
 * production by somebody in a hurry.
 *
 * ## Why it is a third copy of the scratch-database dance
 *
 * `packages/sisyphus-api/src/server/admin/test-database.ts` and
 * `apps/sisyphus-control-plane/src/jobs/workflow-fixtures.ts` already do `create database` /
 * migrate / `drop database`, and this file does it again. That duplication is chosen rather than
 * inherited. The graph these suites need is a different graph: an execution profile with *ordered*
 * credential-group attachments, groups holding credentials in specific states with specific
 * `last_used_at` values, and workflows pinned to those profiles. Neither existing fixture can seed
 * any of it, `seedWorkflow` in both of them leaves `execution_profile_id` null, and widening one of
 * them would couple this feature's suites to a file the jobs phase (T046–T049) is about to edit.
 * The repository has already made this call twice; a third directory-local fixture is the pattern,
 * not a departure from it.
 *
 * ## Why each suite gets its own database
 *
 * The claims under test are **global** ones. "Exactly N of 2N concurrent acquisitions succeed"
 * counts every live lease in the database, and "no credential outside the profile's groups is ever
 * returned" quantifies over every credential there is. A suite that filtered those to its own rows
 * would be proving a weaker rule than the code enforces, and a suite sharing a database with
 * another would see rows it did not seed. So {@link CredentialPoolFixtures.open} creates a database
 * named after a random suffix and migrates it, and {@link CredentialPoolFixtures.close} drops it.
 * Nothing outside it is read, written or dropped, which is also what makes these suites safe to run
 * against a server somebody else is using.
 *
 * ## Why it skips rather than fails
 *
 * With `SISYPHUS_TEST_DATABASE_URL` unset, {@link readTestDatabaseUrl} returns `undefined` and the
 * caller turns its suite into `describe.skipIf`, so `vitest run` on a machine with no Postgres
 * passes rather than erroring on connect. **These suites are about what Postgres does** — a partial
 * unique index refusing a second live lease, a row lock deciding a race — so a run that skips them
 * has proved nothing at all, and the counts are worth reading before believing a green.
 */

/** The environment variable holding the live test database connection string. */
export const TEST_DATABASE_URL_VARIABLE = 'SISYPHUS_TEST_DATABASE_URL'

/**
 * The connection string, or `undefined` when the suite should skip.
 *
 * A blank or whitespace-only value counts as absent: a variable exported as `''` is a
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
  `sisyphus_credential_pool_${suffix.replace(/[^a-z0-9]/g, '')}`

/** A promise and the call that settles it. See {@link createGate}. */
export interface Gate {
  /** Resolves once {@link Gate.open} has been called. */
  readonly opened: Promise<void>
  readonly open: () => void
}

/**
 * A promise plus its resolver, for holding a transaction open at a chosen moment.
 *
 * The one piece of machinery every concurrency test here needs: a transaction cannot be paused from
 * outside, so the test parks it on `await gate.opened` at the instant it cares about, lets other
 * transactions pile up behind the locks it holds, and only then releases it. The same idiom
 * `packages/sisyphus-api/src/server/admin/test-database.ts` established, restated here rather than
 * imported so this fixture has no cross-package test dependency.
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

/**
 * The pool is deliberately over-provisioned with connections.
 *
 * `acquire.test.ts` holds `2N` acquiring transactions open simultaneously, plus a gate transaction
 * holding the row locks they are all blocked on, plus the connection that watches
 * `pg_stat_activity` to prove they are blocked. A pool smaller than that count does not produce a
 * slower test — it produces a test that deadlocks on the *connection pool* rather than on the row
 * lock it is about, and reports a timeout that says nothing about the guarantee.
 */
const POOL_CONNECTIONS = 32

export interface SeedGroupOptions {
  /** Distinguishes fixtures within one suite; combined with the scope's random suffix. */
  readonly label: string
  readonly enabled?: boolean
  /** Soft-deleted. An archived group is not capacity, and selection must not see through it. */
  readonly archived?: boolean
}

export interface SeedCredentialOptions {
  readonly label: string
  readonly credentialGroupId: string
  /** Defaults to `available` — the only selectable state. Typed off the column, not restated. */
  readonly state?: AgentCredential['state']
  readonly enabled?: boolean
  readonly archived?: boolean
  /**
   * Set explicitly wherever a test asserts on least-recently-used order, so the order is data
   * rather than insertion timing. `null` is the newly-registered case, which sorts **first**.
   */
  readonly lastUsedAt?: Date | null
  /**
   * Set explicitly wherever a test asserts on keep-alive scheduling (FR-035). `null` — the default
   * — is a credential nothing has ever proved, which is *due* rather than fresh: the same reading
   * `last_used_at` gets in selection, and for the same reason.
   */
  readonly lastExercisedAt?: Date | null
  /**
   * `workflow` | `keep_alive`, for constructing a row that is already claimed by one of the two
   * contenders FR-038 is about. Only meaningful beside `state: 'held'`.
   */
  readonly heldBy?: string | null
  /** The provider's stated retry time. Null beside `cooling_off` is FR-078's other case. */
  readonly coolingOffUntil?: Date | null
  /** Rendered to administrators verbatim (FR-009), and never material. */
  readonly lastFailureReason?: string | null
  /**
   * Defaults to a Secrets Manager identifier derived from the label. `null` is the FR-008 case: a
   * credential with nowhere to fetch material from, which no code path may hand to a workflow.
   */
  readonly secretId?: string | null
  readonly fence?: number
}

export interface SeedProfileOptions {
  readonly label: string
  /** Ordered attachments. `position` is 1-based and contiguous, as `credential-store.ts` keeps it. */
  readonly groups: readonly { readonly credentialGroupId: string; readonly position: number }[]
}

export interface SeedWorkflowOptions {
  readonly label: string
  /** Omitted for an ad-hoc run: `workflows.execution_profile_id` is nullable (002/FR-126). */
  readonly executionProfileId?: string
  readonly state?: Workflow['state']
}

export interface CredentialPoolFixtures {
  /** The Drizzle handle. A function, because the database is created by {@link CredentialPoolFixtures.open}. */
  readonly db: () => SisyphusDatabase
  /** The random per-scope suffix, for asserting on values the fixtures generated. */
  readonly suffix: string
  /** Create and migrate the scratch database. Call from `beforeAll` with a generous timeout. */
  readonly open: () => Promise<void>
  /** Drop the scratch database. Call from `afterAll`. */
  readonly close: () => Promise<void>
  /** The administrator every fixture row is attributed to. Available after `open()`. */
  readonly ownerUserId: () => string
  readonly seedGroup: (options: SeedGroupOptions) => Promise<string>
  readonly seedCredential: (options: SeedCredentialOptions) => Promise<string>
  readonly seedProfile: (options: SeedProfileOptions) => Promise<string>
  readonly seedWorkflow: (options: SeedWorkflowOptions) => Promise<string>
  /** One credential row, for asserting on the state and fence an acquisition or release left. */
  readonly credential: (id: string) => Promise<AgentCredential | undefined>
  /** Every lease, live or not, oldest first. */
  readonly leases: () => Promise<CredentialLease[]>
  /** Live leases only — the set the exclusivity index bounds. */
  readonly liveLeases: () => Promise<CredentialLease[]>
  /**
   * Every keep-alive exercise recorded against one credential, oldest first.
   *
   * The append-only history research R2 exists to accumulate, read back so a suite can assert that
   * an exercise was recorded *and* what it concluded — the two facts `keep_alive_runs.outcome`
   * carries and the credential's own state does not.
   */
  readonly keepAliveRunsFor: (agentCredentialId: string) => Promise<KeepAliveRun[]>
  /** Audit rows for one entity, oldest first (FR-058). */
  readonly auditFor: (entityId: string) => Promise<ConfigurationAuditEntry[]>
  /** Every audit row this database holds, oldest first. */
  readonly audit: () => Promise<ConfigurationAuditEntry[]>
  /**
   * A live lease inserted directly, bypassing acquisition.
   *
   * Only for constructing drift — a credential row that says `available` while a live lease names
   * it — which is the one shape in which the partial unique index, rather than the conditional
   * update, is what refuses a second holder. Tests that want a lease the ordinary way call
   * `acquireCredential`.
   */
  readonly forceLease: (options: {
    readonly agentCredentialId: string
    readonly workflowId: string
    readonly fence: number
  }) => Promise<string>
  /** Delete every lease and audit row, leaving the pool and its profiles seeded. */
  readonly clearLeases: () => Promise<void>
  /** Backends parked on a lock, for proving that racing transactions really did wait. */
  readonly backendsWaitingOnLocks: () => Promise<number>
  /** Backends inside an open transaction, for proving that a gated one really is open. */
  readonly backendsInTransaction: () => Promise<number>
  /**
   * Run one statement against the scratch database.
   *
   * Exists for exactly one purpose: dropping and restoring `credential_leases_live_key` so a suite
   * can prove its own race test would go red without the index. A test that cannot fail is not
   * evidence, and the only way to know this one can is to take the guarantee away and watch.
   */
  readonly execute: (statement: string) => Promise<void>
}

/**
 * The first row, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this workspace, so `rows[0]` is typed as present even when
 * the result set is empty, and a `=== undefined` guard against it is narrowed away as unreachable.
 * A function whose declared return type admits `undefined` restores the check.
 */
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
export const createCredentialPoolFixtures = (connectionString: string): CredentialPoolFixtures => {
  const suffix = randomUUID().slice(0, 8)
  const databaseName = scratchDatabaseName(suffix)
  let client: DatabaseClient | undefined
  let owner: string | undefined
  let launchable: { bundleVersionId: string; workspaceVersionId: string } | undefined

  const requireClient = (): DatabaseClient => {
    if (client === undefined) {
      throw new Error('The fixture scope was used before open() or after close().')
    }
    return client
  }

  const requireOwner = (): string => {
    if (owner === undefined) {
      throw new Error('The fixture scope was used before open() or after close().')
    }
    return owner
  }

  /**
   * Run one statement against the *configured* database, for `create`/`drop database` — neither of
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

  /** One bundle version and workspace version, shared by every workflow this scope seeds. */
  const requireLaunchable = async (): Promise<{
    bundleVersionId: string
    workspaceVersionId: string
  }> => {
    if (launchable !== undefined) {
      return launchable
    }
    const db = requireClient().db
    const ownerUserId = requireOwner()

    const bundleId = requireId(
      await db
        .insert(setupBundles)
        .values({ name: `pool-bundle-${suffix}`, createdByUserId: ownerUserId })
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
        .values({ name: `pool-workspace-${suffix}` })
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

    launchable = { bundleVersionId, workspaceVersionId }
    return launchable
  }

  return {
    db: () => requireClient().db,
    suffix,
    ownerUserId: requireOwner,

    open: async () => {
      // `drop … if exists` first, so a run killed before its `close` cannot poison the next one.
      await onServer(`drop database if exists ${databaseName} with (force)`)
      await onServer(`create database ${databaseName}`)
      const scratch = withDatabaseName(connectionString, databaseName)
      await runMigrations({ connectionString: scratch })
      client = createDatabaseClient({
        connectionString: scratch,
        maxConnections: POOL_CONNECTIONS,
      })

      owner = requireId(
        await client.db
          .insert(users)
          .values({
            email: `${suffix}-pool-admin@sisyphus.test`,
            googleSubject: `${suffix}-pool-admin`,
            displayName: 'Fixture pool administrator',
            role: 'admin',
          })
          .returning({ id: users.id }),
        'a fixture administrator',
      )
    },

    close: async () => {
      await client?.close()
      client = undefined
      owner = undefined
      launchable = undefined
      await onServer(`drop database if exists ${databaseName} with (force)`)
    },

    seedGroup: async (options) =>
      requireId(
        await requireClient()
          .db.insert(credentialGroups)
          .values({
            name: `${options.label}-${suffix}`,
            enabled: options.enabled ?? true,
            createdByUserId: requireOwner(),
            archivedAt: options.archived === true ? new Date() : null,
          })
          .returning({ id: credentialGroups.id }),
        'a credential group',
      ),

    seedCredential: async (options) =>
      requireId(
        await requireClient()
          .db.insert(agentCredentials)
          .values({
            credentialGroupId: options.credentialGroupId,
            name: `${options.label}-${suffix}`,
            state: options.state ?? 'available',
            enabled: options.enabled ?? true,
            archivedAt: options.archived === true ? new Date() : null,
            lastUsedAt: options.lastUsedAt ?? null,
            lastExercisedAt: options.lastExercisedAt ?? null,
            heldBy: options.heldBy ?? null,
            coolingOffUntil: options.coolingOffUntil ?? null,
            lastFailureReason: options.lastFailureReason ?? null,
            fence: options.fence ?? 0,
            secretId:
              options.secretId === undefined
                ? `sisyphus/agent-credential/${suffix}-${options.label}`
                : options.secretId,
            createdByUserId: requireOwner(),
          })
          .returning({ id: agentCredentials.id }),
        'an agent credential',
      ),

    seedProfile: async (options) => {
      const db = requireClient().db
      const profileId = requireId(
        await db
          .insert(executionProfiles)
          .values({ name: `${options.label}-${suffix}`, enabled: true })
          .returning({ id: executionProfiles.id }),
        'an execution profile',
      )

      if (options.groups.length > 0) {
        await db.insert(profileCredentialGroups).values(
          options.groups.map((attachment) => ({
            executionProfileId: profileId,
            credentialGroupId: attachment.credentialGroupId,
            position: attachment.position,
          })),
        )
      }

      return profileId
    },

    seedWorkflow: async (options) => {
      const { bundleVersionId, workspaceVersionId } = await requireLaunchable()

      return requireId(
        await requireClient()
          .db.insert(workflows)
          .values({
            type: 'delegated',
            state: options.state ?? 'queued',
            ownerUserId: requireOwner(),
            executionProfileId: options.executionProfileId ?? null,
            setupBundleVersionId: bundleVersionId,
            workspaceVersionId,
            assembledPrompt: `Fixture prompt ${options.label}`,
            model: 'claude-sonnet-5',
            instanceType: 'fixture.small',
            purchaseMode: 'spot',
            sessionId: randomUUID(),
          })
          .returning({ id: workflows.id }),
        'a fixture workflow',
      )
    },

    credential: async (id) =>
      firstRow(
        await requireClient().db.select().from(agentCredentials).where(eq(agentCredentials.id, id)),
      ),

    leases: async () =>
      requireClient().db.select().from(credentialLeases).orderBy(asc(credentialLeases.acquiredAt)),

    liveLeases: async () =>
      requireClient()
        .db.select()
        .from(credentialLeases)
        .where(isNull(credentialLeases.releasedAt))
        .orderBy(asc(credentialLeases.acquiredAt)),

    keepAliveRunsFor: async (agentCredentialId) =>
      requireClient()
        .db.select()
        .from(keepAliveRuns)
        .where(eq(keepAliveRuns.agentCredentialId, agentCredentialId))
        .orderBy(asc(keepAliveRuns.ranAt)),

    auditFor: async (entityId) =>
      requireClient()
        .db.select()
        .from(configurationAudit)
        .where(
          and(
            eq(configurationAudit.entityType, 'agent_credential'),
            eq(configurationAudit.entityId, entityId),
          ),
        )
        .orderBy(asc(configurationAudit.createdAt)),

    audit: async () =>
      requireClient()
        .db.select()
        .from(configurationAudit)
        .orderBy(asc(configurationAudit.createdAt)),

    forceLease: async ({ agentCredentialId, workflowId, fence }) =>
      requireId(
        await requireClient()
          .db.insert(credentialLeases)
          .values({ agentCredentialId, workflowId, fence })
          .returning({ id: credentialLeases.id }),
        'a forced fixture lease',
      ),

    clearLeases: async () => {
      const db = requireClient().db
      await db.delete(credentialLeases)
      await db.delete(configurationAudit)
      await db.update(workflows).set({ agentCredentialId: null })
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

    execute: async (statement) => {
      await requireClient().sql.unsafe(statement)
    },
  }
}
