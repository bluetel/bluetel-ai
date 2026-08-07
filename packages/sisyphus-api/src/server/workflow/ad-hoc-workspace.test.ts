import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import { uuidV7, workspaceEntries, workspaces, workspaceVersions } from '../../db'

import {
  copyWorkspaceEntries,
  listLaunchableWorkspaces,
  materialiseRepositoryWorkspace,
  requireLaunchableWorkspaceVersion,
  resolveAdHocWorkspace,
} from './ad-hoc-workspace'
import type { TwoProfileFixture, TwoProfileIds } from './test-support'
import { createTwoProfileFixture, readTestDatabaseUrl } from './test-support'

/**
 * What an ad hoc run checks out (T064a, FR-114, FR-125, FR-129).
 *
 * The property worth holding on to is that both of the form's answers end in the same shape: a
 * `workspace_versions` row with entries hanging off it. Everything downstream — the entry copy,
 * the executor's checkout, the multi-repo machinery — is written once against that shape, and a
 * hand-entered repository that stayed a special case would be a second one.
 */

const connectionString = readTestDatabaseUrl()

const MISSING_ID = '33333333-3333-7333-8333-333333333333'

describe.skipIf(connectionString === undefined)('the ad hoc workspace', () => {
  let fixture: TwoProfileFixture
  let db: SisyphusDatabase
  let ids: TwoProfileIds

  beforeAll(async () => {
    fixture = createTwoProfileFixture(connectionString ?? '')
    await fixture.open()
    db = fixture.db()
    ids = fixture.ids()
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  describe('listLaunchableWorkspaces', () => {
    it('offers the enabled, published workspaces with their current version', async () => {
      const listed = await listLaunchableWorkspaces(db)
      const found = listed.find((workspace) => workspace.id === ids.a.workspaceId)

      expect(found).toMatchObject({
        currentVersionId: ids.a.workspaceVersionId,
        entryCount: 1,
      })
    })

    it('offers both fixture worlds — the picker is not scoped, because only admins see it', async () => {
      const listed = await listLaunchableWorkspaces(db)
      const identifiers = listed.map((workspace) => workspace.id)

      expect(identifiers).toContain(ids.a.workspaceId)
      expect(identifiers).toContain(ids.b.workspaceId)
    })

    it('leaves out a disabled workspace, so the form never offers what a launch would refuse', async () => {
      await db
        .update(workspaces)
        .set({ enabled: false })
        .where(eq(workspaces.id, ids.b.workspaceId))

      const listed = await listLaunchableWorkspaces(db)
      expect(listed.map((workspace) => workspace.id)).not.toContain(ids.b.workspaceId)

      await db.update(workspaces).set({ enabled: true }).where(eq(workspaces.id, ids.b.workspaceId))
    })

    it('leaves out the private workspaces an ad hoc launch materialises', async () => {
      const versionId = await materialiseRepositoryWorkspace(db, {
        repositoryUrl: 'git@github.com:org/private-one.git',
        baseBranch: 'main',
        actorUserId: ids.admin,
      })

      const listed = await listLaunchableWorkspaces(db)
      expect(listed.map((workspace) => workspace.currentVersionId)).not.toContain(versionId)
    })
  })

  describe('requireLaunchableWorkspaceVersion', () => {
    it('admits an enabled, unarchived workspace', async () => {
      await expect(requireLaunchableWorkspaceVersion(db, ids.a.workspaceVersionId)).resolves.toBe(
        ids.a.workspaceVersionId,
      )
    })

    it('refuses a version that does not exist, with NOT_FOUND', async () => {
      await expect(requireLaunchableWorkspaceVersion(db, MISSING_ID)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    })

    it('refuses a disabled workspace with CONFLICT, naming the state', async () => {
      await db
        .update(workspaces)
        .set({ enabled: false })
        .where(eq(workspaces.id, ids.b.workspaceId))

      await expect(
        requireLaunchableWorkspaceVersion(db, ids.b.workspaceVersionId),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'That workspace is disabled and cannot start runs.',
      })

      await db.update(workspaces).set({ enabled: true }).where(eq(workspaces.id, ids.b.workspaceId))
    })

    it('refuses an archived workspace', async () => {
      await db
        .update(workspaces)
        .set({ archivedAt: new Date() })
        .where(eq(workspaces.id, ids.b.workspaceId))

      await expect(
        requireLaunchableWorkspaceVersion(db, ids.b.workspaceVersionId),
      ).rejects.toMatchObject({ message: 'That workspace has been archived.' })

      await db
        .update(workspaces)
        .set({ archivedAt: null })
        .where(eq(workspaces.id, ids.b.workspaceId))
    })
  })

  describe('materialiseRepositoryWorkspace', () => {
    it('creates a version 1 with exactly one primary entry (FR-110)', async () => {
      const versionId = await materialiseRepositoryWorkspace(db, {
        repositoryUrl: 'https://git.test/org/materialised.git',
        baseBranch: 'trunk',
        actorUserId: ids.admin,
      })

      const version = await db
        .select()
        .from(workspaceVersions)
        .where(eq(workspaceVersions.id, versionId))
      expect(version[0]).toMatchObject({ version: 1, createdByUserId: ids.admin })

      const entries = await db
        .select()
        .from(workspaceEntries)
        .where(eq(workspaceEntries.workspaceVersionId, versionId))

      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        repositoryUrl: 'https://git.test/org/materialised.git',
        baseBranch: 'trunk',
        subdirectory: 'materialised',
        isPrimary: true,
        position: 1,
      })
    })

    it('creates the workspace disabled, since nothing has validated it (FR-124)', async () => {
      const versionId = await materialiseRepositoryWorkspace(db, {
        repositoryUrl: 'https://git.test/org/unvalidated.git',
        baseBranch: 'main',
        actorUserId: ids.admin,
      })

      const rows = await db
        .select({ enabled: workspaces.enabled })
        .from(workspaces)
        .innerJoin(workspaceVersions, eq(workspaceVersions.workspaceId, workspaces.id))
        .where(eq(workspaceVersions.id, versionId))

      expect(rows[0]?.enabled).toBe(false)
    })

    it('survives two launches naming the same repository, despite the unique name index', async () => {
      const first = await materialiseRepositoryWorkspace(db, {
        repositoryUrl: 'https://git.test/org/twice.git',
        baseBranch: 'main',
        actorUserId: ids.admin,
      })
      const second = await materialiseRepositoryWorkspace(db, {
        repositoryUrl: 'https://git.test/org/twice.git',
        baseBranch: 'main',
        actorUserId: ids.admin,
      })

      expect(first).not.toBe(second)
    })
  })

  describe('resolveAdHocWorkspace', () => {
    it('reports an existing workspace as chosen rather than created', async () => {
      await expect(
        resolveAdHocWorkspace(db, {
          workspace: { source: 'workspace', workspaceVersionId: ids.a.workspaceVersionId },
          actorUserId: ids.admin,
        }),
      ).resolves.toStrictEqual({
        workspaceVersionId: ids.a.workspaceVersionId,
        materialised: false,
      })
    })

    it('reports a hand-entered repository as materialised', async () => {
      const resolved = await resolveAdHocWorkspace(db, {
        workspace: {
          source: 'repository',
          repositoryUrl: 'https://git.test/org/resolved.git',
          baseBranch: 'main',
        },
        actorUserId: ids.admin,
      })

      expect(resolved.materialised).toBe(true)
      expect(resolved.workspaceVersionId).not.toBe(ids.a.workspaceVersionId)
    })
  })

  describe('copyWorkspaceEntries', () => {
    it('refuses a workspace version with no repositories, before an instance is paid for', async () => {
      const workspaceId = uuidV7()
      const emptyVersionId = uuidV7()

      await db
        .insert(workspaces)
        .values({ id: workspaceId, name: `empty-${workspaceId}`, enabled: false })
      await db
        .insert(workspaceVersions)
        .values({ id: emptyVersionId, workspaceId, version: 1, createdByUserId: ids.admin })

      await expect(
        copyWorkspaceEntries(db, {
          workflowId: ids.a.workflowId,
          workspaceVersionId: emptyVersionId,
        }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'That workspace version has no repositories.',
      })
    })
  })
})
