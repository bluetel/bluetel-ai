import { randomUUID } from 'node:crypto'

import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { DatabaseClient, SisyphusDatabase } from '../db'
import {
  createDatabaseClient,
  executionProfiles,
  executionProfileVersions,
  profileAccessGrants,
  setupBundles,
  setupBundleVersions,
  users,
  workflows,
  workspaces,
  workspaceVersions,
} from '../db'

import type { SisyphusContext } from './context'
import { createCallerFactory, createTRPCRouter, scopedProcedure } from './procedures'
import type { ResolvedScope } from './scope'
import {
  countWorkflowsInScope,
  createScopeResolver,
  createUnauthenticatedScopeResolver,
  findWorkflowInScope,
  memoiseScope,
  requireWorkflowInScope,
  scopedWorkflowWhere,
  visibleWorkflowsFilter,
  workflowNotFoundError,
} from './scope'

const PROFILE_A = '55555555-5555-7555-8555-555555555555'
const USER_A = '11111111-1111-7111-8111-111111111111'

const scopeOf = (overrides: Partial<ResolvedScope> = {}): ResolvedScope => ({
  userId: USER_A,
  isAdmin: false,
  visibleProfileIds: [],
  ...overrides,
})

describe('memoiseScope', () => {
  it('runs the grants query at most once per request', async () => {
    const load = vi.fn(() => Promise.resolve(scopeOf()))
    const resolver = memoiseScope(load)

    await Promise.all([resolver.resolve(), resolver.resolve()])
    await resolver.resolve()

    expect(load).toHaveBeenCalledTimes(1)
  })

  it('runs nothing until something composes a scoped query', () => {
    const load = vi.fn(() => Promise.resolve(scopeOf()))
    memoiseScope(load)

    expect(load).not.toHaveBeenCalled()
  })
})

describe('createScopeResolver', () => {
  it('never queries grants for an admin', async () => {
    const db = new Proxy(
      {},
      {
        get: () => {
          throw new Error('an admin scope must not query profile_access_grants')
        },
      },
    ) as SisyphusDatabase

    const resolver = createScopeResolver({ db, identity: { userId: USER_A, isAdmin: true } })

    await expect(resolver.resolve()).resolves.toStrictEqual({
      userId: USER_A,
      isAdmin: true,
      visibleProfileIds: [],
    })
  })
})

describe('createUnauthenticatedScopeResolver', () => {
  it('treats resolving without a session as UNAUTHORIZED, not as an empty scope', async () => {
    // An empty scope would silently return zero rows, which reads as "you have no workflows"
    // rather than "you are not signed in".
    await expect(createUnauthenticatedScopeResolver().resolve()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })
})

describe('workflowNotFoundError', () => {
  it('is NOT_FOUND, never FORBIDDEN — FORBIDDEN would confirm existence (FR-190)', () => {
    const error = workflowNotFoundError()

    expect(error).toBeInstanceOf(TRPCError)
    expect(error.code).toBe('NOT_FOUND')
    expect(error.code).not.toBe('FORBIDDEN')
  })

  it('names no id, owner or profile in its message', () => {
    expect(workflowNotFoundError().message).toBe('Workflow not found.')
  })
})

/**
 * The base selector, inspected as SQL. No database is contacted — `toSQL()` compiles the query
 * without executing it, so these run everywhere.
 */
describe('visibleWorkflowsFilter', () => {
  let client: DatabaseClient

  beforeAll(() => {
    client = createDatabaseClient({ connectionString: 'postgres://compile-only@127.0.0.1:1/none' })
  })

  afterAll(async () => {
    await client.close()
  })

  const compile = (scope: ResolvedScope): string =>
    client.db.select().from(workflows).where(visibleWorkflowsFilter(scope)).toSQL().sql

  it('lets an admin through without a profile predicate (FR-181)', () => {
    expect(compile(scopeOf({ isAdmin: true }))).toMatch(/where true/i)
  })

  it('matches on granted profiles as well as ownership and initiation', () => {
    const sql = compile(scopeOf({ visibleProfileIds: [PROFILE_A] }))

    expect(sql).toContain('"execution_profile_id" in')
    expect(sql).toContain('"owner_user_id" =')
    expect(sql).toContain('"initiated_by_user_id" =')
  })

  it('keeps the ownership clauses for a caller with no grants at all (FR-189)', () => {
    // Not a convenience: an integration-started workflow is owned by a ticket assignee who may
    // hold no grant, and being accountable for a run you cannot see is not shippable (FR-191).
    const sql = compile(scopeOf({ visibleProfileIds: [] }))

    expect(sql).not.toContain('"execution_profile_id" in')
    expect(sql).toContain('"owner_user_id" =')
    expect(sql).toContain('"initiated_by_user_id" =')
  })

  it('composes the scope clause ahead of a resolver’s own conditions', () => {
    const sql = client.db
      .select()
      .from(workflows)
      .where(scopedWorkflowWhere(scopeOf(), eq(workflows.state, 'running')))
      .toSQL().sql

    expect(sql).toContain('"owner_user_id" =')
    expect(sql).toContain('"state" =')
  })

  it('still scopes when a resolver passes no conditions of its own', () => {
    const sql = client.db.select().from(workflows).where(scopedWorkflowWhere(scopeOf())).toSQL().sql

    expect(sql).toContain('"owner_user_id" =')
  })
})

/**
 * The contract test (T031). Runs against a real Postgres so the predicate is exercised by the
 * database rather than by an assertion about a query object; skipped — not failed — when
 * `SISYPHUS_TEST_DATABASE_URL` is absent, so `vitest run` stays green without one.
 */
const liveDatabaseUrl = process.env['SISYPHUS_TEST_DATABASE_URL']

describe.skipIf(liveDatabaseUrl === undefined || liveDatabaseUrl === '')(
  'out-of-scope reads against a live database',
  () => {
    const suffix = randomUUID().slice(0, 8)
    let client: DatabaseClient
    let db: SisyphusDatabase

    const ids = {
      admin: '',
      owner: '',
      initiator: '',
      grantee: '',
      revoked: '',
      outsider: '',
      bundle: '',
      bundleVersion: '',
      workspace: '',
      workspaceVersion: '',
      profile: '',
      profileVersion: '',
      workflow: '',
    }

    const addUser = async (label: string): Promise<string> => {
      const [row] = await db
        .insert(users)
        .values({
          email: `${label}-${suffix}@sisyphus.test`,
          googleSubject: `google-${label}-${suffix}`,
          displayName: `${label} ${suffix}`,
        })
        .returning({ id: users.id })
      return row.id
    }

    beforeAll(async () => {
      client = createDatabaseClient({ connectionString: liveDatabaseUrl ?? '' })
      db = client.db

      ids.admin = await addUser('admin')
      ids.owner = await addUser('owner')
      ids.initiator = await addUser('initiator')
      ids.grantee = await addUser('grantee')
      ids.revoked = await addUser('revoked')
      ids.outsider = await addUser('outsider')

      await db.update(users).set({ role: 'admin' }).where(eq(users.id, ids.admin))

      const [bundle] = await db
        .insert(setupBundles)
        .values({ name: `bundle-${suffix}`, createdByUserId: ids.admin })
        .returning({ id: setupBundles.id })
      ids.bundle = bundle.id

      const [bundleVersion] = await db
        .insert(setupBundleVersions)
        .values({
          setupBundleId: ids.bundle,
          version: 1,
          s3Key: `bundles/${suffix}.tar.zst`,
          contentDigest: 'a'.repeat(64),
          sizeBytes: 2048,
          registeredByUserId: ids.admin,
        })
        .returning({ id: setupBundleVersions.id })
      ids.bundleVersion = bundleVersion.id

      const [workspace] = await db
        .insert(workspaces)
        .values({ name: `workspace-${suffix}` })
        .returning({ id: workspaces.id })
      ids.workspace = workspace.id

      const [workspaceVersion] = await db
        .insert(workspaceVersions)
        .values({ workspaceId: ids.workspace, version: 1, createdByUserId: ids.admin })
        .returning({ id: workspaceVersions.id })
      ids.workspaceVersion = workspaceVersion.id

      const [profile] = await db
        .insert(executionProfiles)
        .values({ name: `profile-${suffix}` })
        .returning({ id: executionProfiles.id })
      ids.profile = profile.id

      const [profileVersion] = await db
        .insert(executionProfileVersions)
        .values({
          executionProfileId: ids.profile,
          version: 1,
          workspaceVersionId: ids.workspaceVersion,
          setupBundleVersionId: ids.bundleVersion,
          model: 'claude-opus-5',
          instanceType: 'm7i.large',
          defaultWorkflowType: 'delegated',
          createdByUserId: ids.admin,
        })
        .returning({ id: executionProfileVersions.id })
      ids.profileVersion = profileVersion.id

      const [workflow] = await db
        .insert(workflows)
        .values({
          type: 'delegated',
          state: 'running',
          ownerUserId: ids.owner,
          initiatedByUserId: ids.initiator,
          executionProfileId: ids.profile,
          executionProfileVersionId: ids.profileVersion,
          setupBundleVersionId: ids.bundleVersion,
          workspaceVersionId: ids.workspaceVersion,
          model: 'claude-opus-5',
          instanceType: 'm7i.large',
          purchaseMode: 'spot',
          sessionId: randomUUID(),
        })
        .returning({ id: workflows.id })
      ids.workflow = workflow.id

      await db.insert(profileAccessGrants).values({
        userId: ids.grantee,
        executionProfileId: ids.profile,
        grantedByUserId: ids.admin,
      })

      await db.insert(profileAccessGrants).values({
        userId: ids.revoked,
        executionProfileId: ids.profile,
        grantedByUserId: ids.admin,
        revokedAt: new Date(),
        revokedByUserId: ids.admin,
      })
    }, 30_000)

    afterAll(async () => {
      // The database is shared and not assumed empty, so clean up exactly what was seeded, in
      // foreign-key order.
      await db
        .delete(profileAccessGrants)
        .where(eq(profileAccessGrants.executionProfileId, ids.profile))
      await db.delete(workflows).where(eq(workflows.id, ids.workflow))
      await db
        .delete(executionProfileVersions)
        .where(eq(executionProfileVersions.id, ids.profileVersion))
      await db.delete(executionProfiles).where(eq(executionProfiles.id, ids.profile))
      await db.delete(workspaceVersions).where(eq(workspaceVersions.id, ids.workspaceVersion))
      await db.delete(workspaces).where(eq(workspaces.id, ids.workspace))
      await db.delete(setupBundleVersions).where(eq(setupBundleVersions.id, ids.bundleVersion))
      await db.delete(setupBundles).where(eq(setupBundles.id, ids.bundle))
      for (const userId of [
        ids.admin,
        ids.owner,
        ids.initiator,
        ids.grantee,
        ids.revoked,
        ids.outsider,
      ]) {
        await db.delete(users).where(eq(users.id, userId))
      }
      await client.close()
    }, 30_000)

    const resolveScopeFor = async (userId: string, isAdmin = false): Promise<ResolvedScope> =>
      createScopeResolver({ db, identity: { userId, isAdmin } }).resolve()

    /** Read a workflow expecting to be refused, and return the refusal for inspection. */
    const refusalOf = async (scope: ResolvedScope, workflowId: string): Promise<TRPCError> => {
      let captured: unknown
      let refused = false
      try {
        await requireWorkflowInScope({ db, scope, workflowId })
      } catch (caught) {
        refused = true
        captured = caught
      }

      expect(refused).toBe(true)
      return captured as TRPCError
    }

    it('lets a grant holder read the workflow — without which the rest of this file proves nothing', async () => {
      const scope = await resolveScopeFor(ids.grantee)

      expect(scope.visibleProfileIds).toContain(ids.profile)
      await expect(
        requireWorkflowInScope({ db, scope, workflowId: ids.workflow }),
      ).resolves.toMatchObject({ id: ids.workflow })
    })

    it('lets the owner read it with no grant at all (FR-189)', async () => {
      const scope = await resolveScopeFor(ids.owner)

      expect(scope.visibleProfileIds).toStrictEqual([])
      await expect(
        requireWorkflowInScope({ db, scope, workflowId: ids.workflow }),
      ).resolves.toMatchObject({ id: ids.workflow })
    })

    it('lets the initiator read it with no grant at all (FR-189)', async () => {
      const scope = await resolveScopeFor(ids.initiator)

      await expect(
        requireWorkflowInScope({ db, scope, workflowId: ids.workflow }),
      ).resolves.toMatchObject({ id: ids.workflow })
    })

    it('lets an admin read it (FR-181)', async () => {
      const scope = await resolveScopeFor(ids.admin, true)

      await expect(
        requireWorkflowInScope({ db, scope, workflowId: ids.workflow }),
      ).resolves.toMatchObject({ id: ids.workflow })
    })

    it('returns NOT_FOUND — never FORBIDDEN — for a caller outside the scope (FR-190)', async () => {
      const scope = await resolveScopeFor(ids.outsider)

      const error = await refusalOf(scope, ids.workflow)

      expect(error).toBeInstanceOf(TRPCError)
      expect(error.code).toBe('NOT_FOUND')
      // Stated separately and deliberately: FORBIDDEN is the intuitive code here and it is a
      // disclosure, because it answers "does this workflow exist?" with yes.
      expect(error.code).not.toBe('FORBIDDEN')
    })

    it('is indistinguishable from a workflow that does not exist', async () => {
      const scope = await resolveScopeFor(ids.outsider)

      const outOfScope = await refusalOf(scope, ids.workflow)
      const nonexistent = await refusalOf(scope, randomUUID())

      // If these two ever differ — in code, in message, in anything the caller can observe — the
      // difference is an oracle for enumerating workflow ids.
      expect(outOfScope.code).toBe(nonexistent.code)
      expect(outOfScope.message).toBe(nonexistent.message)
    })

    it('hides it from a revoked grant holder (FR-188)', async () => {
      const scope = await resolveScopeFor(ids.revoked)

      expect(scope.visibleProfileIds).toStrictEqual([])
      await expect(
        findWorkflowInScope({ db, scope, workflowId: ids.workflow }),
      ).resolves.toBeUndefined()
    })

    it('excludes it from counts, because a total discloses existence just as well (FR-190)', async () => {
      const outsiderScope = await resolveScopeFor(ids.outsider)
      const granteeScope = await resolveScopeFor(ids.grantee)

      const conditions = [eq(workflows.id, ids.workflow)]

      await expect(countWorkflowsInScope({ db, scope: outsiderScope, conditions })).resolves.toBe(0)
      await expect(countWorkflowsInScope({ db, scope: granteeScope, conditions })).resolves.toBe(1)
    })

    it('surfaces NOT_FOUND through a real scopedProcedure, not only through the helper', async () => {
      const router = createTRPCRouter({
        byId: scopedProcedure.query(({ ctx }) =>
          requireWorkflowInScope({ db: ctx.db, scope: ctx.scope, workflowId: ids.workflow }),
        ),
      })

      const callerFor = (userId: string) => {
        const session = {
          user: {
            id: userId,
            email: `caller-${userId}@sisyphus.test`,
            displayName: 'Caller',
            role: 'engineer' as const,
            isActive: true,
          },
          expiresAt: new Date(Date.now() + 60_000),
        }
        const context: SisyphusContext = {
          headers: new Headers(),
          dependencies: {
            db,
            resolveSession: () => Promise.resolve(session),
            resolveMachineCredential: () => Promise.resolve(null),
            recordDenial: () => Promise.resolve(),
          },
          db,
          session,
          scope: createScopeResolver({ db, identity: { userId, isAdmin: false } }),
          machineCredential: () => Promise.resolve(null),
          validationCredential: () => Promise.resolve(null),
        }
        return createCallerFactory(router)(context)
      }

      await expect(callerFor(ids.grantee).byId()).resolves.toMatchObject({ id: ids.workflow })
      await expect(callerFor(ids.outsider).byId()).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  },
)
