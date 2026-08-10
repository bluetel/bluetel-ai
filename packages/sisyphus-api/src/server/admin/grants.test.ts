import { randomUUID } from 'node:crypto'

import { TRPCError } from '@trpc/server'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DatabaseClient, SisyphusDatabase } from '../../db'
import {
  configurationAudit,
  createDatabaseClient,
  executionProfiles,
  executionProfileVersions,
  profileAccessGrants,
  setupBundles,
  setupBundleVersions,
  users,
  workflowWatchers,
  workflows,
  workspaces,
  workspaceVersions,
} from '../../db'
import type { AuthorisationDenial, SisyphusContext } from '../context'
import { createCallerFactory } from '../procedures'
import { createScopeResolver } from '../scope'

import { adminGrantsRouter, grantTargetNotFoundError } from './grants'

describe('grantTargetNotFoundError', () => {
  it('is NOT_FOUND, never FORBIDDEN — FORBIDDEN would confirm the target exists (FR-190)', () => {
    const error = grantTargetNotFoundError()

    expect(error).toBeInstanceOf(TRPCError)
    expect(error.code).toBe('NOT_FOUND')
    expect(error.code).not.toBe('FORBIDDEN')
  })

  it('names no id, and does not say which of the three things was missing', () => {
    expect(grantTargetNotFoundError().message).toBe('No such user, execution profile or grant.')
  })
})

const liveDatabaseUrl = process.env['SISYPHUS_TEST_DATABASE_URL']

/**
 * The router against a real Postgres. Skipped — not failed — without
 * `SISYPHUS_TEST_DATABASE_URL`, so a plain `vitest run` stays green.
 */
describe.skipIf(liveDatabaseUrl === undefined || liveDatabaseUrl === '')(
  'admin.grants against a live database',
  () => {
    const suffix = randomUUID().slice(0, 8)
    let client: DatabaseClient
    let db: SisyphusDatabase

    const ids = {
      admin: '',
      engineer: '',
      otherOwner: '',
      bundle: '',
      bundleVersion: '',
      workspace: '',
      workspaceVersion: '',
      profile: '',
      profileVersion: '',
      othersWorkflow: '',
      ownedWorkflow: '',
    }

    const denials: AuthorisationDenial[] = []

    const addUser = async (label: string): Promise<string> => {
      const [row] = await db
        .insert(users)
        .values({
          email: `grants-${label}-${suffix}@sisyphus.test`,
          googleSubject: `google-grants-${label}-${suffix}`,
          displayName: `${label} ${suffix}`,
        })
        .returning({ id: users.id })
      return row.id
    }

    const addWorkflow = async (input: {
      readonly ownerUserId: string
      readonly initiatedByUserId: string | null
    }): Promise<string> => {
      const [row] = await db
        .insert(workflows)
        .values({
          type: 'delegated',
          state: 'running',
          ownerUserId: input.ownerUserId,
          initiatedByUserId: input.initiatedByUserId,
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
      return row.id
    }

    /** A caller presenting one user's session. The router's own middleware does the rest. */
    const callerFor = (userId: string, role: 'admin' | 'engineer') => {
      const session = {
        user: {
          id: userId,
          email: `caller-${userId}@sisyphus.test`,
          displayName: 'Caller',
          role,
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
          recordDenial: (denial) => {
            denials.push(denial)
            return Promise.resolve()
          },
        },
        db,
        session,
        scope: createScopeResolver({ db, identity: { userId, isAdmin: role === 'admin' } }),
        machineCredential: () => Promise.resolve(null),
        validationCredential: () => Promise.resolve(null),
      }
      return createCallerFactory(adminGrantsRouter)(context)
    }

    const auditEntriesFor = async (grantId: string) =>
      db
        .select()
        .from(configurationAudit)
        .where(
          and(
            eq(configurationAudit.entityType, 'profile_access_grant'),
            eq(configurationAudit.entityId, grantId),
          ),
        )

    beforeAll(async () => {
      client = createDatabaseClient({ connectionString: liveDatabaseUrl ?? '' })
      db = client.db

      ids.admin = await addUser('admin')
      ids.engineer = await addUser('engineer')
      ids.otherOwner = await addUser('other-owner')
      await db.update(users).set({ role: 'admin' }).where(eq(users.id, ids.admin))

      const [bundle] = await db
        .insert(setupBundles)
        .values({ name: `grants-bundle-${suffix}`, createdByUserId: ids.admin })
        .returning({ id: setupBundles.id })
      ids.bundle = bundle.id

      const [bundleVersion] = await db
        .insert(setupBundleVersions)
        .values({
          setupBundleId: ids.bundle,
          version: 1,
          s3Key: `bundles/grants-${suffix}.tar.zst`,
          contentDigest: 'b'.repeat(64),
          sizeBytes: 1024,
          registeredByUserId: ids.admin,
        })
        .returning({ id: setupBundleVersions.id })
      ids.bundleVersion = bundleVersion.id

      const [workspace] = await db
        .insert(workspaces)
        .values({ name: `grants-workspace-${suffix}` })
        .returning({ id: workspaces.id })
      ids.workspace = workspace.id

      const [workspaceVersion] = await db
        .insert(workspaceVersions)
        .values({ workspaceId: ids.workspace, version: 1, createdByUserId: ids.admin })
        .returning({ id: workspaceVersions.id })
      ids.workspaceVersion = workspaceVersion.id

      const [profile] = await db
        .insert(executionProfiles)
        .values({ name: `grants-profile-${suffix}` })
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

      // One run the engineer can only see through the grant, and one they own outright. The
      // integration-shaped null initiator on the first is deliberate: it is the case a bare `<>`
      // comparison silently excludes from the cascade.
      ids.othersWorkflow = await addWorkflow({
        ownerUserId: ids.otherOwner,
        initiatedByUserId: null,
      })
      ids.ownedWorkflow = await addWorkflow({
        ownerUserId: ids.engineer,
        initiatedByUserId: ids.engineer,
      })
    }, 30_000)

    afterAll(async () => {
      await db.delete(configurationAudit).where(eq(configurationAudit.actorUserId, ids.admin))
      for (const workflowId of [ids.othersWorkflow, ids.ownedWorkflow]) {
        await db.delete(workflowWatchers).where(eq(workflowWatchers.workflowId, workflowId))
        await db.delete(workflows).where(eq(workflows.id, workflowId))
      }
      await db
        .delete(profileAccessGrants)
        .where(eq(profileAccessGrants.executionProfileId, ids.profile))
      await db
        .delete(executionProfileVersions)
        .where(eq(executionProfileVersions.id, ids.profileVersion))
      await db.delete(executionProfiles).where(eq(executionProfiles.id, ids.profile))
      await db.delete(workspaceVersions).where(eq(workspaceVersions.id, ids.workspaceVersion))
      await db.delete(workspaces).where(eq(workspaces.id, ids.workspace))
      await db.delete(setupBundleVersions).where(eq(setupBundleVersions.id, ids.bundleVersion))
      await db.delete(setupBundles).where(eq(setupBundles.id, ids.bundle))
      for (const userId of [ids.admin, ids.engineer, ids.otherOwner]) {
        await db.delete(users).where(eq(users.id, userId))
      }
      await client.close()
    }, 30_000)

    it('refuses a non-admin and records the denial (FR-169)', async () => {
      denials.length = 0

      await expect(
        callerFor(ids.engineer, 'engineer').grant({
          userId: ids.engineer,
          executionProfileId: ids.profile,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })

      expect(denials.map((denial) => denial.reason)).toContain('not_admin')
    })

    it('issues a grant and records it with the acting admin (FR-184)', async () => {
      const issued = await callerFor(ids.admin, 'admin').grant({
        userId: ids.engineer,
        executionProfileId: ids.profile,
      })

      expect(issued.created).toBe(true)
      expect(issued.grant.revokedAt).toBeNull()
      expect(issued.grant.grantedByUserId).toBe(ids.admin)

      const entries = await auditEntriesFor(issued.grant.id)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ action: 'granted', actorUserId: ids.admin })
      expect(entries[0]?.detail).toMatchObject({
        userId: ids.engineer,
        executionProfileId: ids.profile,
      })
    })

    it('treats a repeated grant as a duplicate request, not an error', async () => {
      const again = await callerFor(ids.admin, 'admin').grant({
        userId: ids.engineer,
        executionProfileId: ids.profile,
      })

      expect(again.created).toBe(false)

      // No second row and no second audit entry: nothing changed, so nothing is recorded.
      const rows = await db
        .select({ id: profileAccessGrants.id })
        .from(profileAccessGrants)
        .where(eq(profileAccessGrants.executionProfileId, ids.profile))
      expect(rows).toHaveLength(1)
      await expect(auditEntriesFor(again.grant.id)).resolves.toHaveLength(1)
    })

    it('lists live grants for the profile, and the history when asked', async () => {
      const live = await callerFor(ids.admin, 'admin').listForProfile({
        executionProfileId: ids.profile,
      })

      expect(live.items).toHaveLength(1)
      expect(live.items[0]?.userId).toBe(ids.engineer)
    })

    it('lists what a user holds', async () => {
      const held = await callerFor(ids.admin, 'admin').listForUser({ userId: ids.engineer })

      expect(held.items.map((row) => row.executionProfileId)).toStrictEqual([ids.profile])
    })

    it('revokes the watch the grant was keeping alive, and keeps the one it was not (FR-188)', async () => {
      await db.insert(workflowWatchers).values([
        { workflowId: ids.othersWorkflow, userId: ids.engineer },
        { workflowId: ids.ownedWorkflow, userId: ids.engineer },
      ])

      const revoked = await callerFor(ids.admin, 'admin').revoke({
        userId: ids.engineer,
        executionProfileId: ids.profile,
      })

      expect(revoked.grant.revokedAt).toBeInstanceOf(Date)
      expect(revoked.grant.revokedByUserId).toBe(ids.admin)
      expect(revoked.watchesRemoved).toBe(1)

      const remaining = await db
        .select({ workflowId: workflowWatchers.workflowId })
        .from(workflowWatchers)
        .where(eq(workflowWatchers.userId, ids.engineer))

      // The watch on the run they own survives — revocation must not strip someone of a workflow
      // they are accountable for (FR-189).
      expect(remaining.map((row) => row.workflowId)).toStrictEqual([ids.ownedWorkflow])

      const entries = await auditEntriesFor(revoked.grant.id)
      expect(entries.map((entry) => entry.action).sort()).toStrictEqual(['granted', 'revoked'])
      expect(entries.find((entry) => entry.action === 'revoked')?.detail).toMatchObject({
        watchesRemoved: 1,
      })
    })

    it('keeps the revoked grant readable as history rather than deleting it (FR-184)', async () => {
      const history = await callerFor(ids.admin, 'admin').listForProfile({
        executionProfileId: ids.profile,
        includeRevoked: true,
      })

      expect(history.items).toHaveLength(1)
      expect(history.items[0]?.revokedAt).toBeInstanceOf(Date)

      const live = await callerFor(ids.admin, 'admin').listForProfile({
        executionProfileId: ids.profile,
      })
      expect(live.items).toHaveLength(0)
    })

    it('grants again after a revocation', async () => {
      const reissued = await callerFor(ids.admin, 'admin').grant({
        userId: ids.engineer,
        executionProfileId: ids.profile,
      })

      expect(reissued.created).toBe(true)
      expect(reissued.grant.revokedAt).toBeNull()

      const all = await callerFor(ids.admin, 'admin').listForProfile({
        executionProfileId: ids.profile,
        includeRevoked: true,
      })
      expect(all.items).toHaveLength(2)
    })

    it('reports an unknown profile, an unknown user and an absent grant identically (FR-190)', async () => {
      const caller = callerFor(ids.admin, 'admin')
      const expected = {
        code: 'NOT_FOUND',
        message: 'No such user, execution profile or grant.',
      }

      // If any of these ever differ in code or message, the difference is an oracle for
      // enumerating user and profile ids.
      await expect(
        caller.grant({ userId: ids.engineer, executionProfileId: randomUUID() }),
      ).rejects.toMatchObject(expected)
      await expect(
        caller.grant({ userId: randomUUID(), executionProfileId: ids.profile }),
      ).rejects.toMatchObject(expected)
      await expect(
        caller.revoke({ userId: ids.otherOwner, executionProfileId: ids.profile }),
      ).rejects.toMatchObject(expected)
      await expect(
        caller.listForProfile({ executionProfileId: randomUUID() }),
      ).rejects.toMatchObject(expected)
      await expect(caller.listForUser({ userId: randomUUID() })).rejects.toMatchObject(expected)
    })

    it('leaves an admin’s watches alone, because they never rested on the grant (FR-183)', async () => {
      await callerFor(ids.admin, 'admin').grant({
        userId: ids.admin,
        executionProfileId: ids.profile,
      })
      await db
        .insert(workflowWatchers)
        .values({ workflowId: ids.othersWorkflow, userId: ids.admin })

      const revoked = await callerFor(ids.admin, 'admin').revoke({
        userId: ids.admin,
        executionProfileId: ids.profile,
      })

      expect(revoked.watchesRemoved).toBe(0)
      await expect(
        db
          .select({ id: workflowWatchers.id })
          .from(workflowWatchers)
          .where(eq(workflowWatchers.userId, ids.admin)),
      ).resolves.toHaveLength(1)
    })
  },
)
