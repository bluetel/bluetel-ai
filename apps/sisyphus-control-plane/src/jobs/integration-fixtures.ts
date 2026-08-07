import { randomUUID } from 'node:crypto'

import type { DatabaseClient, Integration, SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import {
  createDatabaseClient,
  executionProfiles,
  executionProfileVersions,
  integrationMappings,
  integrations,
  setupBundles,
  setupBundleVersions,
  ticketClaims,
  users,
  workflows,
  workspaces,
  workspaceVersions,
} from '@bluetel-ai/sisyphus-api/db'
import { runMigrations } from '@bluetel-ai/sisyphus-api/db/migrations'
import { count, eq } from 'drizzle-orm'

import { readTestDatabaseUrl, withDatabaseName } from './workflow-fixtures'

/**
 * **Test support for the live-database integration suites. Not production code.**
 *
 * The same shape as `workflow-fixtures.ts`, and for the same reason: each suite gets a private,
 * freshly-migrated database, so a test that proves two overlapping ticks start exactly one workflow
 * can say what "one workflow" means without another suite seeding rows underneath it.
 *
 * Deliberately **not** re-exported from `src/jobs/index.ts` — exporting it would put a fixture
 * seeder one import away from a job.
 *
 * With `SISYPHUS_TEST_DATABASE_URL` unset the caller skips its suite, so a plain `vitest run` on a
 * machine with no Postgres passes rather than erroring on connect.
 */

export { readTestDatabaseUrl } from './workflow-fixtures'

/** Lower-case and alphanumeric, so never quoted. */
export const integrationScratchDatabaseName = (suffix: string): string =>
  `sisyphus_integration_${suffix.replace(/[^a-z0-9]/g, '')}`

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

const requireId = (rows: readonly { readonly id: string }[], what: string): string => {
  const id = firstRow(rows)?.id
  if (id === undefined) {
    throw new Error(`Seeding ${what} returned no row.`)
  }
  return id
}

export interface SeedIntegrationOptions {
  readonly name?: string
  readonly enabled?: boolean
  readonly baseUrl?: string
  readonly projectPrefix?: string
  readonly promptIntro?: string
  readonly cronExpression?: string
  readonly timezone?: string
  readonly perTickCeiling?: number
  readonly rollingPeriodCeiling?: number
  readonly rollingPeriodMinutes?: number
  readonly consecutiveFailures?: number
  /** Omit the default owner, to exercise the no-accountable-human refusal (FR-133). */
  readonly withoutDefaultOwner?: boolean
}

export interface IntegrationFixtures {
  readonly db: () => SisyphusDatabase
  readonly suffix: string
  readonly open: () => Promise<void>
  readonly close: () => Promise<void>
  /** The owner every seeded integration defaults to, and the profile's author. */
  readonly ownerUserId: () => string
  /** An enabled execution profile with a published version, which mappings resolve to. */
  readonly executionProfileId: () => string
  readonly seedIntegration: (options?: SeedIntegrationOptions) => Promise<Integration>
  /** A catch-all mapping at position 0, so every candidate resolves. */
  readonly seedMapping: (input: {
    readonly integrationId: string
    readonly position?: number
    readonly criteria?: Record<string, unknown>
    readonly executionProfileId?: string
  }) => Promise<string>
  readonly seedUser: (email: string) => Promise<string>
  readonly disableProfile: () => Promise<void>
  readonly countWorkflows: () => Promise<number>
  readonly countWorkflowsFor: (integrationId: string) => Promise<number>
  readonly countClaims: () => Promise<number>
  readonly readIntegration: (integrationId: string) => Promise<Integration | undefined>
  readonly readWorkflowPrompt: (
    workflowId: string,
  ) => Promise<{ readonly prompt: string | null; readonly truncated: boolean } | undefined>
  readonly removeAll: () => Promise<void>
}

export const createIntegrationFixtures = (connectionString: string): IntegrationFixtures => {
  const suffix = randomUUID().slice(0, 8)
  const databaseName = integrationScratchDatabaseName(suffix)
  let client: DatabaseClient | undefined
  let seeded:
    | { ownerUserId: string; executionProfileId: string; workspaceVersionId: string }
    | undefined

  const requireClient = (): DatabaseClient => {
    if (client === undefined) {
      throw new Error('The fixture scope was used before open() or after close().')
    }
    return client
  }

  const requireSeeded = () => {
    if (seeded === undefined) {
      throw new Error('The fixture scope has no shared rows yet; call seedIntegration first.')
    }
    return seeded
  }

  const onServer = async (statement: string): Promise<void> => {
    const admin = createDatabaseClient({ connectionString, maxConnections: 1 })
    try {
      await admin.sql.unsafe(statement)
    } finally {
      await admin.close()
    }
  }

  const seedShared = async () => {
    if (seeded !== undefined) {
      return seeded
    }
    const db = requireClient().db

    const ownerUserId = requireId(
      await db
        .insert(users)
        .values({
          email: `${suffix}-owner@sisyphus.test`,
          googleSubject: `${suffix}-owner`,
          displayName: 'Fixture owner',
          role: 'admin',
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

    const setupBundleVersionId = requireId(
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

    const executionProfileId = requireId(
      await db
        .insert(executionProfiles)
        .values({ name: `fixture-profile-${suffix}`, enabled: true })
        .returning({ id: executionProfiles.id }),
      'an execution profile',
    )

    const versionId = requireId(
      await db
        .insert(executionProfileVersions)
        .values({
          executionProfileId,
          version: 1,
          workspaceVersionId,
          setupBundleVersionId,
          model: 'claude-sonnet-5',
          instanceType: 'fixture.small',
          purchaseMode: 'spot',
          defaultWorkflowType: 'delegated',
          promptPreamble: 'The contract lives in packages/contracts.',
          createdByUserId: ownerUserId,
        })
        .returning({ id: executionProfileVersions.id }),
      'an execution profile version',
    )

    await db
      .update(executionProfiles)
      .set({ currentVersionId: versionId })
      .where(eq(executionProfiles.id, executionProfileId))

    seeded = { ownerUserId, executionProfileId, workspaceVersionId }
    return seeded
  }

  return {
    db: () => requireClient().db,
    suffix,
    ownerUserId: () => requireSeeded().ownerUserId,
    executionProfileId: () => requireSeeded().executionProfileId,

    open: async () => {
      await onServer(`drop database if exists ${databaseName} with (force)`)
      await onServer(`create database ${databaseName}`)
      const scratch = withDatabaseName(connectionString, databaseName)
      await runMigrations({ connectionString: scratch })
      // More than the default: the exactly-once suite holds two ticks in flight at once, and a pool
      // of one would serialise them into the very thing the test is trying to overlap.
      client = createDatabaseClient({ connectionString: scratch, maxConnections: 10 })
    },

    close: async () => {
      await client?.close()
      client = undefined
      await onServer(`drop database if exists ${databaseName} with (force)`)
    },

    seedIntegration: async (options = {}) => {
      const shared = await seedShared()
      const row = firstRow(
        await requireClient()
          .db.insert(integrations)
          .values({
            type: 'jira',
            name: options.name ?? `fixture-board-${suffix}-${randomUUID().slice(0, 4)}`,
            baseUrl: options.baseUrl ?? 'https://boards.invalid',
            credentialSecretArn: `arn:fixture:secret:${suffix}`,
            projectPrefix: options.projectPrefix ?? 'FIX',
            label: 'sisyphus',
            defaultOwnerUserId: options.withoutDefaultOwner === true ? null : shared.ownerUserId,
            promptIntro: options.promptIntro ?? 'Work from this board ships as one pull request.',
            cronExpression: options.cronExpression ?? '0/15 * * * *',
            timezone: options.timezone ?? 'Europe/London',
            perTickCeiling: options.perTickCeiling ?? 5,
            rollingPeriodCeiling: options.rollingPeriodCeiling ?? 20,
            rollingPeriodMinutes: options.rollingPeriodMinutes ?? 60,
            enabled: options.enabled ?? true,
            consecutiveFailures: options.consecutiveFailures ?? 0,
          })
          .returning(),
      )

      if (row === undefined) {
        throw new Error('Seeding an integration returned no row.')
      }

      return row
    },

    seedMapping: async (input) =>
      requireId(
        await requireClient()
          .db.insert(integrationMappings)
          .values({
            integrationId: input.integrationId,
            position: input.position ?? 0,
            criteria: input.criteria ?? {},
            executionProfileId: input.executionProfileId ?? requireSeeded().executionProfileId,
            isDefault: input.criteria === undefined,
          })
          .returning({ id: integrationMappings.id }),
        'an integration mapping',
      ),

    seedUser: async (email) =>
      requireId(
        await requireClient()
          .db.insert(users)
          .values({
            email,
            googleSubject: `${suffix}-${email}`,
            displayName: email,
            role: 'engineer',
          })
          .returning({ id: users.id }),
        'a fixture user',
      ),

    disableProfile: async () => {
      await requireClient()
        .db.update(executionProfiles)
        .set({ enabled: false })
        .where(eq(executionProfiles.id, requireSeeded().executionProfileId))
    },

    countWorkflows: async () => {
      const rows = await requireClient().db.select({ value: count() }).from(workflows)
      return firstRow(rows)?.value ?? 0
    },

    countWorkflowsFor: async (integrationId) => {
      const rows = await requireClient()
        .db.select({ value: count() })
        .from(workflows)
        .where(eq(workflows.originatingIntegrationId, integrationId))
      return firstRow(rows)?.value ?? 0
    },

    countClaims: async () => {
      const rows = await requireClient().db.select({ value: count() }).from(ticketClaims)
      return firstRow(rows)?.value ?? 0
    },

    readIntegration: async (integrationId) =>
      firstRow(
        await requireClient()
          .db.select()
          .from(integrations)
          .where(eq(integrations.id, integrationId)),
      ),

    readWorkflowPrompt: async (workflowId) => {
      const row = firstRow(
        await requireClient()
          .db.select({
            prompt: workflows.assembledPrompt,
            truncated: workflows.promptTruncated,
          })
          .from(workflows)
          .where(eq(workflows.id, workflowId)),
      )

      return row === undefined ? undefined : { prompt: row.prompt, truncated: row.truncated }
    },

    removeAll: async () => {
      await requireClient().sql.unsafe(
        'truncate table users, workspaces, setup_bundles, execution_profiles, integrations restart identity cascade',
      )
      seeded = undefined
    },
  }
}

/** Convenience: the URL, or `undefined` when the suite should skip. */
export const integrationTestDatabaseUrl = (): string | undefined => readTestDatabaseUrl()
