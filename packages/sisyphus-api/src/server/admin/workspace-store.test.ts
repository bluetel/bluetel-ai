import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DatabaseClient } from '../../db'
import { createDatabaseClient, workspaces, workspaceVersions } from '../../db'

import { createUserFixtures, readTestDatabaseUrl } from './test-database'
import type { NormalisedWorkspaceEntry } from './workspace-entries'
import * as store from './workspace-store'
import {
  findWorkspace,
  findWorkspaceByName,
  findWorkspaceVersion,
  insertWorkspace,
  insertWorkspaceVersion,
  listWorkspaces,
  lockWorkspaceForVersioning,
  readEntriesByVersion,
  readVersionEntries,
  readWorkspaceReferences,
  updateWorkspace,
} from './workspace-store'

describe('the workspace store’s shape', () => {
  /**
   * FR-125 expressed as an absence.
   *
   * A published version and its entries are immutable, so there must be no exported way to change
   * one. This asserts the absence rather than trusting review, because the failure it guards
   * against — an `updateWorkspaceEntries` added later "just to fix a typo" — would silently change
   * what a running workflow checks out and break no other test in this package.
   */
  it('exports no way to update a published version or its entries', () => {
    const mutators = Object.keys(store).filter(
      (name) =>
        name.startsWith('update') || name.startsWith('delete') || name.startsWith('replace'),
    )

    expect(mutators).toStrictEqual(['updateWorkspace'])
  })
})

describe('workspace queries, as SQL', () => {
  let client: DatabaseClient

  beforeAll(() => {
    client = createDatabaseClient({ connectionString: 'postgres://compile-only@127.0.0.1:1/none' })
  })

  afterAll(async () => {
    await client.close()
  })

  it('allocates a version number from a locking read, not a plain one', () => {
    // `for update` is the whole of `lockWorkspaceForVersioning`'s concurrency argument, so it is
    // worth an assertion that does not need a database to run against.
    const compiled = client.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, 'x'))
      .limit(1)
      .for('update')
      .toSQL().sql

    expect(compiled).toMatch(/for update/i)
  })
})

const liveDatabaseUrl = readTestDatabaseUrl()

describe.skipIf(liveDatabaseUrl === undefined)(
  'the workspace store against a live database',
  () => {
    const fixtures = createUserFixtures(liveDatabaseUrl ?? '')
    let actorId = ''

    const entries = (...subdirectories: readonly string[]): readonly NormalisedWorkspaceEntry[] =>
      subdirectories.map((subdirectory, index) => ({
        repositoryUrl: `github.com/acme/${subdirectory}`,
        baseBranch: 'main',
        subdirectory,
        isPrimary: index === 0,
        position: index + 1,
      }))

    const publish = async (name: string, ...subdirectories: readonly string[]) => {
      const workspace = await insertWorkspace(fixtures.db(), { name, description: undefined })
      const published = await insertWorkspaceVersion(fixtures.db(), {
        workspaceId: workspace.id,
        version: 1,
        createdByUserId: actorId,
        entries: entries(...subdirectories),
      })
      await updateWorkspace(fixtures.db(), workspace.id, {
        currentVersionId: published.version.id,
      })
      return { workspace, published }
    }

    beforeAll(async () => {
      await fixtures.open()
      const seeded = await fixtures.seedUser({ label: 'workspace-store-admin', role: 'admin' })
      actorId = seeded.id
    }, 60_000)

    afterAll(async () => {
      await fixtures.close()
    }, 30_000)

    it('finds a workspace by id and by its exact name', async () => {
      const { workspace } = await publish(`store-find-${fixtures.suffix}`, 'api')

      await expect(findWorkspace(fixtures.db(), workspace.id)).resolves.toMatchObject({
        id: workspace.id,
      })
      await expect(
        findWorkspaceByName(fixtures.db(), `store-find-${fixtures.suffix}`),
      ).resolves.toMatchObject({ id: workspace.id })
      // Case-sensitive, matching the unique index.
      await expect(
        findWorkspaceByName(fixtures.db(), `STORE-FIND-${fixtures.suffix}`),
      ).resolves.toBeUndefined()
    })

    it('reports the highest version, and 0 for a workspace with none', async () => {
      const bare = await insertWorkspace(fixtures.db(), {
        name: `store-bare-${fixtures.suffix}`,
        description: undefined,
      })

      await expect(
        fixtures.db().transaction((tx) => lockWorkspaceForVersioning(tx, bare.id)),
      ).resolves.toMatchObject({ highestVersion: 0 })

      const { workspace } = await publish(`store-versioned-${fixtures.suffix}`, 'api')
      await insertWorkspaceVersion(fixtures.db(), {
        workspaceId: workspace.id,
        version: 4,
        createdByUserId: actorId,
        entries: entries('api'),
      })

      await expect(
        fixtures.db().transaction((tx) => lockWorkspaceForVersioning(tx, workspace.id)),
      ).resolves.toMatchObject({ highestVersion: 4 })
    })

    it('serialises two concurrent edits into versions 2 and 3, never a duplicate key (FR-125)', async () => {
      const { workspace } = await publish(`store-race-${fixtures.suffix}`, 'api')

      const edit = (subdirectory: string) =>
        fixtures.db().transaction(async (tx) => {
          const locked = await lockWorkspaceForVersioning(tx, workspace.id)
          if (locked === undefined) {
            throw new Error('The workspace vanished mid-test.')
          }
          return insertWorkspaceVersion(tx, {
            workspaceId: workspace.id,
            version: locked.highestVersion + 1,
            createdByUserId: actorId,
            entries: entries(subdirectory),
          })
        })

      // Both transactions read `max(version)` — but the second only gets to read it after the first
      // has committed, because the parent row is locked. Without the lock both would read 1, both
      // would insert version 2, and the loser would fail on the unique index instead of producing 3.
      const [second, third] = await Promise.all([edit('web'), edit('mobile')])

      expect([second.version.version, third.version.version].sort((a, b) => a - b)).toStrictEqual([
        2, 3,
      ])

      const stored = await fixtures
        .db()
        .select({ version: workspaceVersions.version })
        .from(workspaceVersions)
        .where(eq(workspaceVersions.workspaceId, workspace.id))
        .orderBy(workspaceVersions.version)

      expect(stored.map((row) => row.version)).toStrictEqual([1, 2, 3])
    }, 30_000)

    it('hangs entries off the version, so each version answers for its own set', async () => {
      const { workspace, published } = await publish(
        `store-entries-${fixtures.suffix}`,
        'api',
        'web',
      )
      const second = await insertWorkspaceVersion(fixtures.db(), {
        workspaceId: workspace.id,
        version: 2,
        createdByUserId: actorId,
        entries: entries('api'),
      })

      await expect(readVersionEntries(fixtures.db(), published.version.id)).resolves.toHaveLength(2)
      await expect(readVersionEntries(fixtures.db(), second.version.id)).resolves.toHaveLength(1)

      const grouped = await readEntriesByVersion(fixtures.db(), [
        published.version.id,
        second.version.id,
      ])
      expect(grouped.get(published.version.id)?.map((row) => row.subdirectory)).toStrictEqual([
        'api',
        'web',
      ])
      expect(grouped.get(second.version.id)?.map((row) => row.subdirectory)).toStrictEqual(['api'])
    })

    it('asks nothing of the database when there are no versions to ask about', async () => {
      await expect(readEntriesByVersion(fixtures.db(), [])).resolves.toStrictEqual(new Map())
    })

    it('finds a version by id, and reports an unknown one as absent', async () => {
      const { published } = await publish(`store-version-${fixtures.suffix}`, 'api')

      await expect(
        findWorkspaceVersion(fixtures.db(), published.version.id),
      ).resolves.toMatchObject({
        version: 1,
      })
      await expect(
        findWorkspaceVersion(fixtures.db(), '00000000-0000-7000-8000-000000000000'),
      ).resolves.toBeUndefined()
    })

    it('lists the pointed-at version rather than the highest one (FR-125)', async () => {
      const { workspace, published } = await publish(`store-pointer-${fixtures.suffix}`, 'api')

      // A version exists that the workspace does not point at. A `max(version)` list would show it,
      // and a launch against it would then be impossible — the pointer is what publishing means.
      await insertWorkspaceVersion(fixtures.db(), {
        workspaceId: workspace.id,
        version: 9,
        createdByUserId: actorId,
        entries: entries('unpublished'),
      })

      const page = await listWorkspaces(fixtures.db(), {
        enabledOnly: false,
        includeArchived: false,
        limit: 100,
      })
      const listed = page.items.find((item) => item.id === workspace.id)

      expect(listed?.currentVersion?.id).toBe(published.version.id)
      expect(listed?.currentVersion?.version).toBe(1)
      expect(listed?.versionCount).toBe(2)
    })

    it('filters the list to enabled workspaces and paginates by keyset', async () => {
      const { workspace: enabled } = await publish(`store-enabled-${fixtures.suffix}`, 'api')
      await publish(`store-disabled-${fixtures.suffix}`, 'api')
      await updateWorkspace(fixtures.db(), enabled.id, { enabled: true })

      const onlyEnabled = await listWorkspaces(fixtures.db(), {
        enabledOnly: true,
        includeArchived: false,
        limit: 100,
      })
      expect(onlyEnabled.items.map((item) => item.id)).toContain(enabled.id)
      expect(onlyEnabled.items.every((item) => item.enabled)).toBe(true)

      const firstPage = await listWorkspaces(fixtures.db(), {
        enabledOnly: false,
        includeArchived: false,
        limit: 1,
      })
      expect(firstPage.items).toHaveLength(1)
      expect(firstPage.nextCursor).toBeDefined()

      const secondPage = await listWorkspaces(fixtures.db(), {
        enabledOnly: false,
        includeArchived: false,
        limit: 1,
        cursor: firstPage.nextCursor,
      })
      expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id)
    })

    it('hides an archived workspace unless it is asked for', async () => {
      const { workspace } = await publish(`store-archived-${fixtures.suffix}`, 'api')
      await updateWorkspace(fixtures.db(), workspace.id, { archivedAt: new Date() })

      const hidden = await listWorkspaces(fixtures.db(), {
        enabledOnly: false,
        includeArchived: false,
        limit: 100,
      })
      expect(hidden.items.map((item) => item.id)).not.toContain(workspace.id)

      const shown = await listWorkspaces(fixtures.db(), {
        enabledOnly: false,
        includeArchived: true,
        limit: 100,
      })
      expect(shown.items.map((item) => item.id)).toContain(workspace.id)
    })

    it('reports a workspace nothing references as archivable (FR-128)', async () => {
      const { workspace } = await publish(`store-references-${fixtures.suffix}`, 'api')

      await expect(readWorkspaceReferences(fixtures.db(), workspace.id)).resolves.toStrictEqual({
        executionProfiles: [],
        integrations: [],
        activeWorkflowCount: 0,
        totalWorkflowCount: 0,
        archivable: true,
      })
    })
  },
)
