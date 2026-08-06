import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import { executionProfiles, executionProfileVersions, profileAccessGrants } from '../../db'

import type { AdHocJobSpec } from './ad-hoc-plan'
import { saveConfigurationAsProfile } from './save-as-profile'
import type { TwoProfileFixture, TwoProfileIds } from './test-support'
import { createTwoProfileFixture, readTestDatabaseUrl } from './test-support'

/**
 * "Save this configuration as an execution profile" (T064a, FR-129).
 *
 * The two assertions that matter are about what it declines to do. A profile is the unit of access
 * control (FR-179) and may not be enabled until validation has confirmed its bundle and its
 * repositories (FR-124) — so a profile created as a by-product of a launch must arrive disabled
 * and ungranted, or the ad hoc path becomes a way to mint launch presets that skipped both.
 */

const connectionString = readTestDatabaseUrl()

const spec: AdHocJobSpec = {
  workflowType: 'delegated',
  model: 'claude-opus-5',
  instanceType: 'm7i.2xlarge',
  purchaseMode: 'on_demand',
  turnCap: 30,
  spendCap: '18.5000',
}

describe.skipIf(connectionString === undefined)('saveConfigurationAsProfile', () => {
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

  const save = (name: string, description?: string) =>
    saveConfigurationAsProfile(db, {
      saveAs: description === undefined ? { name } : { name, description },
      spec,
      workspaceVersionId: ids.a.workspaceVersionId,
      setupBundleVersionId: ids.bundleVersion,
      actorUserId: ids.admin,
    })

  it('writes version 1 carrying the entered job spec, pinned to the same versions', async () => {
    const saved = await save('Configuration one')
    const rows = await db
      .select()
      .from(executionProfileVersions)
      .where(eq(executionProfileVersions.id, saved.executionProfileVersionId))

    expect(rows[0]).toMatchObject({
      version: 1,
      workspaceVersionId: ids.a.workspaceVersionId,
      setupBundleVersionId: ids.bundleVersion,
      model: 'claude-opus-5',
      instanceType: 'm7i.2xlarge',
      purchaseMode: 'on_demand',
      turnCap: 30,
      spendCap: '18.5000',
      defaultWorkflowType: 'delegated',
      createdByUserId: ids.admin,
    })
  })

  it('advances the profile’s current version pointer, which is what publishing is (FR-125)', async () => {
    const saved = await save('Configuration two')
    const rows = await db
      .select()
      .from(executionProfiles)
      .where(eq(executionProfiles.id, saved.executionProfileId))

    expect(rows[0]?.currentVersionId).toBe(saved.executionProfileVersionId)
  })

  it('creates it disabled, because nothing has validated it (FR-124)', async () => {
    const saved = await save('Configuration three')
    const rows = await db
      .select()
      .from(executionProfiles)
      .where(eq(executionProfiles.id, saved.executionProfileId))

    expect(rows[0]?.enabled).toBe(false)
  })

  it('grants it to nobody — access is its own separately audited act (FR-184)', async () => {
    const saved = await save('Configuration four')

    expect(
      await db
        .select()
        .from(profileAccessGrants)
        .where(eq(profileAccessGrants.executionProfileId, saved.executionProfileId)),
    ).toStrictEqual([])
  })

  it('does not copy the launch prompt into the preamble (FR-157)', async () => {
    const saved = await save('Configuration five')
    const rows = await db
      .select()
      .from(executionProfileVersions)
      .where(eq(executionProfileVersions.id, saved.executionProfileVersionId))

    expect(rows[0]?.promptPreamble).toBeNull()
  })

  it('locks nothing, because a profile nobody holds has no holders to constrain (FR-123)', async () => {
    const saved = await save('Configuration six')
    const rows = await db
      .select()
      .from(executionProfileVersions)
      .where(eq(executionProfileVersions.id, saved.executionProfileVersionId))

    expect(rows[0]?.lockedFields).toStrictEqual([])
  })

  it('keeps the description when one was given, and takes null when none was', async () => {
    const described = await save('Configuration seven', 'Kept from a launch.')
    const bare = await save('Configuration eight')

    const rows = await db.select().from(executionProfiles)
    const find = (id: string) => rows.find((row) => row.id === id)

    expect(find(described.executionProfileId)?.description).toBe('Kept from a launch.')
    expect(find(bare.executionProfileId)?.description).toBeNull()
  })

  it('refuses a name already taken, and says nothing was started', async () => {
    await save('Configuration nine')

    await expect(save('Configuration nine')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('Nothing was started') as unknown as string,
    })
  })
})
