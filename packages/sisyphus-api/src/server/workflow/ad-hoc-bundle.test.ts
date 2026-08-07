import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import { setupBundles, setupBundleVersions, uuidV7 } from '../../db'

import { requireSelectableBundleVersion } from './ad-hoc-bundle'
import type { TwoProfileFixture, TwoProfileIds } from './test-support'
import { createTwoProfileFixture, readTestDatabaseUrl } from './test-support'

/**
 * "Only enabled setup bundles are selectable" (FR-016, FR-086), on the one launch path where the
 * bundle version arrives straight off a form rather than through a validated profile.
 *
 * A bundle is arbitrary shell run with the instance's privileges, so disabling one is how an admin
 * takes a broken or untrusted archive out of service. These assertions are what stop that being
 * advisory.
 */

const connectionString = readTestDatabaseUrl()

const MISSING_ID = '44444444-4444-7444-8444-444444444444'

describe.skipIf(connectionString === undefined)('requireSelectableBundleVersion', () => {
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

  /** A second bundle, so enabling and archiving can be varied without touching the fixture's. */
  const seedBundle = async (options: {
    readonly label: string
    readonly enabled: boolean
    readonly archived: boolean
  }): Promise<string> => {
    const bundleId = uuidV7()
    await db.insert(setupBundles).values({
      id: bundleId,
      name: `bundle-${options.label}-${bundleId}`,
      enabled: options.enabled,
      archivedAt: options.archived ? new Date() : null,
      createdByUserId: ids.admin,
    })

    const versionId = uuidV7()
    await db.insert(setupBundleVersions).values({
      id: versionId,
      setupBundleId: bundleId,
      version: 1,
      s3Key: `bundles/${versionId}.tar.zst`,
      contentDigest: 'b'.repeat(64),
      sizeBytes: 1024,
      registeredByUserId: ids.admin,
    })

    return versionId
  }

  it('admits an enabled, unarchived bundle', async () => {
    await expect(requireSelectableBundleVersion(db, ids.bundleVersion)).resolves.toBe(
      ids.bundleVersion,
    )
  })

  it('refuses a version that does not exist, with NOT_FOUND', async () => {
    await expect(requireSelectableBundleVersion(db, MISSING_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('refuses a disabled bundle, naming the state so the form can say what to do', async () => {
    const versionId = await seedBundle({ label: 'off', enabled: false, archived: false })

    await expect(requireSelectableBundleVersion(db, versionId)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'That setup bundle is disabled and cannot start runs.',
    })
  })

  it('refuses an archived bundle even while it is still enabled', async () => {
    const versionId = await seedBundle({ label: 'gone', enabled: true, archived: true })

    await expect(requireSelectableBundleVersion(db, versionId)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'That setup bundle has been archived.',
    })
  })

  it('follows the version to its parent rather than trusting the version alone', async () => {
    const versionId = await seedBundle({ label: 'flip', enabled: true, archived: false })
    await expect(requireSelectableBundleVersion(db, versionId)).resolves.toBe(versionId)

    const parent = await db
      .select({ id: setupBundleVersions.setupBundleId })
      .from(setupBundleVersions)
      .where(eq(setupBundleVersions.id, versionId))

    await db
      .update(setupBundles)
      .set({ enabled: false })
      .where(eq(setupBundles.id, parent[0]?.id ?? ''))

    await expect(requireSelectableBundleVersion(db, versionId)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })
})
