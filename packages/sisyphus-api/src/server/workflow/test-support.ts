import { randomUUID } from 'node:crypto'

import type { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'

import type { SisyphusDatabase } from '../../db'
import {
  artifacts,
  executionProfiles,
  executionProfileVersions,
  integrations,
  logSegments,
  profileAccessGrants,
  setupBundles,
  setupBundleVersions,
  workflowEntries,
  workflowEvents,
  workflows,
  workspaceEntries,
  workspaces,
  workspaceVersions,
} from '../../db'
import { createUserFixtures } from '../admin/test-database'
import type { ResolvedScope } from '../scope'
import { createScopeResolver } from '../scope'

/**
 * **The two-profile fixture. Test support for the live-database suites in this directory.**
 *
 * It lives in `src/` because that is where the tests that import it live and where the type
 * checker and linter can see it, and it is deliberately **not** re-exported from `./index.ts` —
 * exporting it would put a fixture seeder one import away from application code, exactly as
 * `admin/test-database.ts` is kept out of `admin/index.ts`.
 *
 * ## Why two of everything
 *
 * FR-190 is a rule about what a caller *cannot* see, and a fixture with one profile cannot express
 * it: every query would return everything, and a selector broken to return nothing would look
 * identical to one that worked. So this seeds two complete, disjoint worlds — two profiles, two
 * workspaces, two integrations, two repositories, two owners, two runs with different spend —
 * granted to two different users, with a third user granted neither. Every assertion in
 * `queries.test.ts` is then a pair: *this* user sees their own run through this path, **and** does
 * not see the other one.
 *
 * ## Why the database lifecycle is borrowed rather than rewritten
 *
 * `createUserFixtures` already creates a private, freshly-migrated scratch database per suite and
 * drops it afterwards, which is what keeps these suites safe to run against a server somebody else
 * is using. This adds seeding on top of it and nothing else — there is one database harness in
 * this package and this is not a second one.
 *
 * With `SISYPHUS_TEST_DATABASE_URL` unset the caller skips its suite, so a plain `vitest run` on a
 * machine with no Postgres passes rather than erroring on connect.
 */

/** One of the two disjoint worlds the fixture seeds. */
export interface SeededWorld {
  readonly workspaceId: string
  readonly workspaceVersionId: string
  readonly workspaceEntryId: string
  readonly executionProfileId: string
  readonly executionProfileVersionId: string
  readonly integrationId: string
  readonly workflowId: string
  readonly workflowEntryId: string
  readonly artifactId: string
  readonly repositoryUrl: string
  readonly ticketReference: string
}

/** Every id the fixture seeded, so assertions name rows rather than search for them. */
export interface TwoProfileIds {
  readonly admin: string
  /** Holds a live grant on profile A; owns and initiated workflow A. */
  readonly alice: string
  /** Holds a live grant on profile B; owns and initiated workflow B. */
  readonly bob: string
  /** Holds nothing, owns nothing, initiated nothing. The negative case. */
  readonly outsider: string
  readonly bundle: string
  readonly bundleVersion: string
  readonly a: SeededWorld
  readonly b: SeededWorld
}

export interface TwoProfileFixture {
  readonly db: () => SisyphusDatabase
  /** Create, migrate and seed. Call from `beforeAll` with a generous timeout. */
  readonly open: () => Promise<void>
  /** Drop the scratch database. Call from `afterAll`. */
  readonly close: () => Promise<void>
  /** Only valid after {@link TwoProfileFixture.open}. */
  readonly ids: () => TwoProfileIds
  /** The resolved scope for one user, through the real resolver rather than a hand-built object. */
  readonly scopeFor: (userId: string, isAdmin?: boolean) => Promise<ResolvedScope>
}

/** Spend recorded on each run. Different values, so a leaked total is arithmetically visible. */
export const SPEND_A = '11.0000'
export const SPEND_B = '97.0000'
export const TURNS_A = 3
export const TURNS_B = 7

/** The field profile A locks, so the FR-123 refusal has something real to refuse. */
export const LOCKED_FIELD_A = 'instanceType'

/**
 * The first row, honestly typed. `noUncheckedIndexedAccess` is off in this project, so `rows[0]`
 * is typed as present even when the result set is empty.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

const requireId = (rows: readonly { readonly id: string }[], what: string): string => {
  const id = firstRow(rows)?.id
  if (id === undefined) {
    throw new Error(`Seeding ${what} returned no row.`)
  }
  return id
}

/**
 * Run something that is expected to be refused, and hand back the refusal for inspection.
 *
 * Shared because the assertions that matter most in these suites are about the *shape* of a
 * refusal — its code and its exact message — and a `.catch(caught => caught)` returns a union with
 * the success value, which those assertions then cannot read.
 */
export const refusalOf = async (run: () => Promise<unknown>): Promise<TRPCError> => {
  try {
    await run()
  } catch (caught) {
    return caught as TRPCError
  }
  throw new Error('Expected the call to be refused, but it succeeded.')
}

/**
 * Build the fixture.
 *
 * @param connectionString - From `readTestDatabaseUrl`. The caller has already skipped when it is
 *   `undefined`, so this never has to decide what to do without one.
 */
export const createTwoProfileFixture = (connectionString: string): TwoProfileFixture => {
  const base = createUserFixtures(connectionString)
  const { suffix } = base
  let seeded: TwoProfileIds | undefined

  const seedWorld = async (options: {
    readonly label: 'a' | 'b'
    readonly adminUserId: string
    readonly ownerUserId: string
    readonly bundleVersionId: string
    readonly spendUsed: string
    readonly turnsUsed: number
    readonly lockedFields: readonly string[]
  }): Promise<SeededWorld> => {
    const db = base.db()
    const { label, adminUserId, ownerUserId, bundleVersionId } = options
    const upper = label.toUpperCase()

    const workspaceId = requireId(
      await db
        .insert(workspaces)
        .values({ name: `workspace-${label}-${suffix}`, enabled: true })
        .returning({ id: workspaces.id }),
      'a workspace',
    )

    const workspaceVersionId = requireId(
      await db
        .insert(workspaceVersions)
        .values({ workspaceId, version: 1, createdByUserId: adminUserId })
        .returning({ id: workspaceVersions.id }),
      'a workspace version',
    )

    await db
      .update(workspaces)
      .set({ currentVersionId: workspaceVersionId })
      .where(eq(workspaces.id, workspaceId))

    const repositoryUrl = `https://git.test/${suffix}/${label}.git`
    const workspaceEntryId = requireId(
      await db
        .insert(workspaceEntries)
        .values({
          workspaceVersionId,
          repositoryUrl,
          baseBranch: 'main',
          subdirectory: label,
          isPrimary: true,
          position: 1,
        })
        .returning({ id: workspaceEntries.id }),
      'a workspace entry',
    )

    const executionProfileId = requireId(
      await db
        .insert(executionProfiles)
        .values({ name: `profile-${label}-${suffix}`, enabled: true })
        .returning({ id: executionProfiles.id }),
      'an execution profile',
    )

    const executionProfileVersionId = requireId(
      await db
        .insert(executionProfileVersions)
        .values({
          executionProfileId,
          version: 1,
          workspaceVersionId,
          setupBundleVersionId: bundleVersionId,
          model: 'claude-opus-5',
          instanceType: 'm7i.large',
          purchaseMode: 'spot',
          turnCap: 40,
          spendCap: '25.0000',
          defaultWorkflowType: 'delegated',
          promptPreamble: `Preamble ${upper}`,
          lockedFields: [...options.lockedFields],
          createdByUserId: adminUserId,
        })
        .returning({ id: executionProfileVersions.id }),
      'an execution profile version',
    )

    await db
      .update(executionProfiles)
      .set({ currentVersionId: executionProfileVersionId })
      .where(eq(executionProfiles.id, executionProfileId))

    const integrationId = requireId(
      await db
        .insert(integrations)
        .values({
          type: 'jira',
          name: `integration-${label}-${suffix}`,
          baseUrl: `https://jira.test/${label}`,
          credentialSecretArn: `arn:aws:secretsmanager:eu-west-1:0:secret:${label}-${suffix}`,
          projectPrefix: upper,
          label: `Client ${upper}`,
          promptIntro: `Work from board ${upper}.`,
          cronExpression: '0 * * * *',
          timezone: 'Europe/London',
          perTickCeiling: 1,
          rollingPeriodCeiling: 5,
          rollingPeriodMinutes: 60,
          defaultOwnerUserId: ownerUserId,
        })
        .returning({ id: integrations.id }),
      'an integration',
    )

    const ticketReference = `${upper}-1`
    const workflowId = requireId(
      await db
        .insert(workflows)
        .values({
          type: 'delegated',
          state: 'running',
          ownerUserId,
          initiatedByUserId: ownerUserId,
          originatingIntegrationId: integrationId,
          executionProfileId,
          executionProfileVersionId,
          setupBundleVersionId: bundleVersionId,
          workspaceVersionId,
          ticketReference,
          resultBranchName: `sisyphus/${label}-${suffix}`,
          assembledPrompt: `Do the ${upper} work.`,
          model: 'claude-opus-5',
          instanceType: 'm7i.large',
          purchaseMode: 'spot',
          turnsUsed: options.turnsUsed,
          spendUsed: options.spendUsed,
          sessionId: randomUUID(),
        })
        .returning({ id: workflows.id }),
      'a workflow',
    )

    const workflowEntryId = requireId(
      await db
        .insert(workflowEntries)
        .values({
          workflowId,
          workspaceEntryId,
          repositoryUrl,
          baseBranch: 'main',
          subdirectory: label,
          isPrimary: true,
        })
        .returning({ id: workflowEntries.id }),
      'a workflow entry',
    )

    await db.insert(workflowEvents).values({
      workflowId,
      event: 'created',
      actorType: 'user',
      actorUserId: ownerUserId,
      detail: { world: label },
    })

    await db.insert(logSegments).values({
      workflowId,
      sequence: 0,
      s3Key: `logs/${workflowId}/0.txt`,
      byteSize: 128,
      startedAt: new Date(Date.now() - 60_000),
      endedAt: new Date(),
    })

    const artifactId = requireId(
      await db
        .insert(artifacts)
        .values({
          workflowId,
          entryId: workflowEntryId,
          kind: 'pull_request',
          externalUrl: `https://git.test/${suffix}/${label}/pull/1`,
        })
        .returning({ id: artifacts.id }),
      'an artifact',
    )

    return {
      workspaceId,
      workspaceVersionId,
      workspaceEntryId,
      executionProfileId,
      executionProfileVersionId,
      integrationId,
      workflowId,
      workflowEntryId,
      artifactId,
      repositoryUrl,
      ticketReference,
    }
  }

  return {
    db: base.db,

    ids: () => {
      if (seeded === undefined) {
        throw new Error('The fixture was used before open() or after close().')
      }
      return seeded
    },

    open: async () => {
      await base.open()
      const db = base.db()

      const admin = await base.seedUser({ label: 'admin', role: 'admin' })
      const alice = await base.seedUser({ label: 'alice' })
      const bob = await base.seedUser({ label: 'bob' })
      const outsider = await base.seedUser({ label: 'outsider' })

      const bundle = requireId(
        await db
          .insert(setupBundles)
          .values({ name: `bundle-${suffix}`, enabled: true, createdByUserId: admin.id })
          .returning({ id: setupBundles.id }),
        'a setup bundle',
      )

      const bundleVersion = requireId(
        await db
          .insert(setupBundleVersions)
          .values({
            setupBundleId: bundle,
            version: 1,
            s3Key: `bundles/${suffix}.tar.zst`,
            contentDigest: 'a'.repeat(64),
            sizeBytes: 2048,
            registeredByUserId: admin.id,
          })
          .returning({ id: setupBundleVersions.id }),
        'a setup bundle version',
      )

      const a = await seedWorld({
        label: 'a',
        adminUserId: admin.id,
        ownerUserId: alice.id,
        bundleVersionId: bundleVersion,
        spendUsed: SPEND_A,
        turnsUsed: TURNS_A,
        lockedFields: [LOCKED_FIELD_A],
      })

      const b = await seedWorld({
        label: 'b',
        adminUserId: admin.id,
        ownerUserId: bob.id,
        bundleVersionId: bundleVersion,
        spendUsed: SPEND_B,
        turnsUsed: TURNS_B,
        lockedFields: [],
      })

      await db.insert(profileAccessGrants).values([
        { userId: alice.id, executionProfileId: a.executionProfileId, grantedByUserId: admin.id },
        { userId: bob.id, executionProfileId: b.executionProfileId, grantedByUserId: admin.id },
      ])

      seeded = {
        admin: admin.id,
        alice: alice.id,
        bob: bob.id,
        outsider: outsider.id,
        bundle,
        bundleVersion,
        a,
        b,
      }
    },

    close: async () => {
      seeded = undefined
      await base.close()
    },

    scopeFor: (userId, isAdmin = false) =>
      createScopeResolver({ db: base.db(), identity: { userId, isAdmin } }).resolve(),
  }
}

/**
 * Re-exported so a suite needs one import to decide whether to run — and one idiom, shared with
 * the admin suites, for holding a transaction open while a second one commits.
 */
export { createGate, readTestDatabaseUrl } from '../admin/test-database'
export type { Gate } from '../admin/test-database'
