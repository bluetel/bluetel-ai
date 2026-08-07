import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DatabaseClient } from '../../db'
import {
  createDatabaseClient,
  executionProfiles,
  executionProfileVersions,
  profileAccessGrants,
  setupBundles,
  setupBundleVersions,
  workspaceEntries,
  workspaces,
  workspaceVersions,
} from '../../db'

import * as store from './profile-store'
import {
  findProfile,
  findProfileByName,
  findProfileVersion,
  insertProfile,
  insertProfileVersion,
  listProfiles,
  lockProfileForVersioning,
  readProfileEnableSubject,
  readProfileReferences,
  updateProfile,
} from './profile-store'
import { createUserFixtures, readTestDatabaseUrl } from './test-database'

describe('the profile store’s shape', () => {
  /**
   * FR-125 expressed as an absence.
   *
   * A published version is immutable — it is what `workflows.execution_profile_version_id`
   * reconstructs a finished run's configuration from — so there must be no exported way to change
   * one. The failure this guards against is an `updateProfileVersion` added later "to fix a typo in
   * the preamble", which would silently rewrite the history of every run that pinned it.
   */
  it('exports no way to update a published version', () => {
    const mutators = Object.keys(store).filter(
      (name) =>
        name.startsWith('update') || name.startsWith('delete') || name.startsWith('replace'),
    )

    expect(mutators).toStrictEqual(['updateProfile'])
  })
})

describe('profile queries, as SQL', () => {
  let client: DatabaseClient

  beforeAll(() => {
    client = createDatabaseClient({ connectionString: 'postgres://compile-only@127.0.0.1:1/none' })
  })

  afterAll(async () => {
    await client.close()
  })

  it('allocates a version number from a locking read, not a plain one', () => {
    const compiled = client.db
      .select()
      .from(executionProfiles)
      .where(eq(executionProfiles.id, 'x'))
      .limit(1)
      .for('update')
      .toSQL().sql

    expect(compiled).toMatch(/for update/i)
  })
})

const liveDatabaseUrl = readTestDatabaseUrl()

describe.skipIf(liveDatabaseUrl === undefined)('the profile store against a live database', () => {
  const fixtures = createUserFixtures(liveDatabaseUrl ?? '')
  let actorId = ''
  let bundleVersionId = ''
  let workspaceVersionId = ''

  const launchValues = () => ({
    workspaceVersionId,
    setupBundleVersionId: bundleVersionId,
    model: 'claude-sonnet-5' as const,
    instanceType: 'm7i.xlarge',
    purchaseMode: 'on_demand' as const,
    turnCap: 20,
    spendCap: '10.0000',
    defaultWorkflowType: 'delegated' as const,
    promptPreamble: null,
    lockedFields: [] as readonly string[],
    createdByUserId: '',
  })

  const publish = async (name: string) => {
    const profile = await insertProfile(fixtures.db(), { name, description: undefined })
    const version = await insertProfileVersion(fixtures.db(), {
      ...launchValues(),
      createdByUserId: actorId,
      executionProfileId: profile.id,
      version: 1,
    })
    await updateProfile(fixtures.db(), profile.id, { currentVersionId: version.id })
    return { profile, version }
  }

  beforeAll(async () => {
    await fixtures.open()
    const seeded = await fixtures.seedUser({ label: 'profile-store-admin', role: 'admin' })
    actorId = seeded.id

    const [bundle] = await fixtures
      .db()
      .insert(setupBundles)
      .values({ name: `store-bundle-${fixtures.suffix}`, enabled: true, createdByUserId: actorId })
      .returning({ id: setupBundles.id })
    const [bundleVersion] = await fixtures
      .db()
      .insert(setupBundleVersions)
      .values({
        setupBundleId: bundle.id,
        version: 5,
        s3Key: `fixtures/${fixtures.suffix}.tar.gz`,
        contentDigest: 'b'.repeat(64),
        sizeBytes: 1,
        registeredByUserId: actorId,
      })
      .returning({ id: setupBundleVersions.id })
    bundleVersionId = bundleVersion.id

    const [workspace] = await fixtures
      .db()
      .insert(workspaces)
      .values({ name: `store-workspace-${fixtures.suffix}` })
      .returning({ id: workspaces.id })
    const [workspaceVersion] = await fixtures
      .db()
      .insert(workspaceVersions)
      .values({ workspaceId: workspace.id, version: 2, createdByUserId: actorId })
      .returning({ id: workspaceVersions.id })
    workspaceVersionId = workspaceVersion.id

    await fixtures.db().insert(workspaceEntries).values({
      workspaceVersionId,
      repositoryUrl: 'github.com/acme/api',
      baseBranch: 'main',
      subdirectory: 'api',
      isPrimary: true,
      position: 1,
    })
  }, 60_000)

  afterAll(async () => {
    await fixtures.close()
  }, 30_000)

  it('finds a profile by id and by its exact name', async () => {
    const { profile } = await publish(`store-find-${fixtures.suffix}`)

    await expect(findProfile(fixtures.db(), profile.id)).resolves.toMatchObject({ id: profile.id })
    await expect(
      findProfileByName(fixtures.db(), `store-find-${fixtures.suffix}`),
    ).resolves.toMatchObject({ id: profile.id })
    await expect(
      findProfileByName(fixtures.db(), `STORE-FIND-${fixtures.suffix}`),
    ).resolves.toBeUndefined()
  })

  it('creates a profile disabled, whatever else it is given', async () => {
    const { profile } = await publish(`store-disabled-${fixtures.suffix}`)
    expect(profile.enabled).toBe(false)
  })

  it('serialises two concurrent edits into versions 2 and 3, never a duplicate key (FR-125)', async () => {
    const { profile } = await publish(`store-race-${fixtures.suffix}`)

    const edit = (instanceType: string) =>
      fixtures.db().transaction(async (tx) => {
        const locked = await lockProfileForVersioning(tx, profile.id)
        if (locked === undefined) {
          throw new Error('The profile vanished mid-test.')
        }
        return insertProfileVersion(tx, {
          ...launchValues(),
          createdByUserId: actorId,
          executionProfileId: profile.id,
          version: locked.highestVersion + 1,
          instanceType,
        })
      })

    const [second, third] = await Promise.all([edit('m7i.2xlarge'), edit('m7i.4xlarge')])

    expect([second.version, third.version].sort((a, b) => a - b)).toStrictEqual([2, 3])

    const stored = await fixtures
      .db()
      .select({ version: executionProfileVersions.version })
      .from(executionProfileVersions)
      .where(eq(executionProfileVersions.executionProfileId, profile.id))
      .orderBy(executionProfileVersions.version)

    expect(stored.map((row) => row.version)).toStrictEqual([1, 2, 3])
  }, 30_000)

  it('lists the pointed-at version rather than the highest one (FR-125)', async () => {
    const { profile, version } = await publish(`store-pointer-${fixtures.suffix}`)

    // A version exists that the profile does not point at. `loadLaunchableProfileVersion` reads the
    // pointer, so a list showing `max(version)` would offer a configuration no run could start on.
    await insertProfileVersion(fixtures.db(), {
      ...launchValues(),
      createdByUserId: actorId,
      executionProfileId: profile.id,
      version: 9,
      instanceType: 'never.launched',
    })

    const page = await listProfiles(fixtures.db(), {
      enabledOnly: false,
      includeArchived: false,
      limit: 100,
    })
    const listed = page.items.find((item) => item.id === profile.id)

    expect(listed?.currentVersion?.id).toBe(version.id)
    expect(listed?.currentVersion?.instanceType).toBe('m7i.xlarge')
    expect(listed?.versionCount).toBe(2)
  })

  it('finds a version by id, and reports an unknown one as absent', async () => {
    const { version } = await publish(`store-version-${fixtures.suffix}`)

    await expect(findProfileVersion(fixtures.db(), version.id)).resolves.toMatchObject({
      version: 1,
    })
    await expect(
      findProfileVersion(fixtures.db(), '00000000-0000-7000-8000-000000000000'),
    ).resolves.toBeUndefined()
  })

  it('paginates by keyset and hides an archived profile unless asked', async () => {
    const { profile } = await publish(`store-archived-${fixtures.suffix}`)
    await updateProfile(fixtures.db(), profile.id, { archivedAt: new Date() })

    const hidden = await listProfiles(fixtures.db(), {
      enabledOnly: false,
      includeArchived: false,
      limit: 100,
    })
    expect(hidden.items.map((item) => item.id)).not.toContain(profile.id)

    const shown = await listProfiles(fixtures.db(), {
      enabledOnly: false,
      includeArchived: true,
      limit: 100,
    })
    expect(shown.items.map((item) => item.id)).toContain(profile.id)

    const firstPage = await listProfiles(fixtures.db(), {
      enabledOnly: false,
      includeArchived: false,
      limit: 1,
    })
    expect(firstPage.nextCursor).toBeDefined()

    const secondPage = await listProfiles(fixtures.db(), {
      enabledOnly: false,
      includeArchived: false,
      limit: 1,
      cursor: firstPage.nextCursor,
    })
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id)
  })

  it('reads the bundle and workspace a version pins, through their version rows (FR-124)', async () => {
    const { version } = await publish(`store-subject-${fixtures.suffix}`)

    await expect(readProfileEnableSubject(fixtures.db(), version)).resolves.toMatchObject({
      setupBundleName: `store-bundle-${fixtures.suffix}`,
      // The pinned version, not the bundle's latest: a profile validated against one archive has
      // not been silently re-pointed at another.
      setupBundleVersion: 5,
      setupBundleEnabled: true,
      setupBundleArchived: false,
      workspaceName: `store-workspace-${fixtures.suffix}`,
      workspaceVersion: 2,
      workspaceArchived: false,
    })

    const subject = await readProfileEnableSubject(fixtures.db(), version)
    expect(subject?.entries.map((entry) => entry.repositoryUrl)).toStrictEqual([
      'github.com/acme/api',
    ])
  })

  it('reports a version whose pinned rows do not exist as unreadable', async () => {
    await expect(
      readProfileEnableSubject(fixtures.db(), {
        setupBundleVersionId: '00000000-0000-7000-8000-000000000000',
        workspaceVersionId,
      }),
    ).resolves.toBeUndefined()
  })

  it('counts live grants and reports an unreferenced profile as archivable (FR-128)', async () => {
    const { profile } = await publish(`store-references-${fixtures.suffix}`)
    const holder = await fixtures.seedUser({ label: 'profile-store-holder' })

    await expect(readProfileReferences(fixtures.db(), profile.id)).resolves.toStrictEqual({
      integrations: [],
      activeWorkflowCount: 0,
      totalWorkflowCount: 0,
      liveGrantCount: 0,
      archivable: true,
    })

    const [grant] = await fixtures
      .db()
      .insert(profileAccessGrants)
      .values({
        userId: holder.id,
        executionProfileId: profile.id,
        grantedByUserId: actorId,
      })
      .returning({ id: profileAccessGrants.id })

    await expect(readProfileReferences(fixtures.db(), profile.id)).resolves.toMatchObject({
      liveGrantCount: 1,
      // A grant is not a reason to refuse archiving: revoking is a separate, audited act (FR-184).
      archivable: true,
    })

    await fixtures
      .db()
      .update(profileAccessGrants)
      .set({ revokedAt: new Date(), revokedByUserId: actorId })
      .where(eq(profileAccessGrants.id, grant.id))

    await expect(readProfileReferences(fixtures.db(), profile.id)).resolves.toMatchObject({
      liveGrantCount: 0,
    })
  })
})
