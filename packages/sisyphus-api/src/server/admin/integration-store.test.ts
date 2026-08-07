import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  executionProfiles,
  executionProfileVersions,
  integrationRuns,
  setupBundles,
  setupBundleVersions,
  ticketClaims,
  workspaces,
  workspaceVersions,
} from '../../db'

import {
  deleteIntegration,
  findIntegration,
  findIntegrationByName,
  findLatestRun,
  insertIntegration,
  integrationColumns,
  listIntegrations,
  listRuns,
  readConnectorTarget,
  readContractMappings,
  readIntegrationReferences,
  readProfilePreamble,
  replaceMappings,
  updateIntegration,
} from './integration-store'
import { createUserFixtures, readTestDatabaseUrl } from './test-database'

describe('the columns the panel may see (FR-098)', () => {
  it('does not include the credential reference', () => {
    expect(Object.keys(integrationColumns)).not.toContain('credentialSecretArn')
  })

  it('does include everything an admin needs to understand the schedule and its health', () => {
    for (const column of [
      'cronExpression',
      'timezone',
      'perTickCeiling',
      'rollingPeriodCeiling',
      'consecutiveFailures',
      'autoDisabledReason',
      'scheduleArn',
    ]) {
      expect(Object.keys(integrationColumns)).toContain(column)
    }
  })
})

const liveDatabaseUrl = readTestDatabaseUrl()

describe.skipIf(liveDatabaseUrl === undefined)(
  'the integration store against a live database',
  () => {
    const fixtures = createUserFixtures(liveDatabaseUrl ?? '')

    let adminId = ''
    let executionProfileId = ''
    let created = 0

    const values = (overrides: Record<string, unknown> = {}) => {
      created += 1
      return {
        type: 'jira' as const,
        name: `board-${fixtures.suffix}-${String(created)}`,
        baseUrl: 'https://boards.invalid',
        credentialSecretArn: `arn:fixture:secret:${fixtures.suffix}`,
        projectPrefix: 'FIX',
        label: 'sisyphus',
        defaultOwnerUserId: adminId,
        promptIntro: 'Work from this board ships as one pull request.',
        cronExpression: '0/15 * * * *',
        timezone: 'Europe/London',
        perTickCeiling: 3,
        rollingPeriodCeiling: 12,
        rollingPeriodMinutes: 60,
        ...overrides,
      }
    }

    beforeAll(async () => {
      await fixtures.open()

      const admin = await fixtures.seedUser({ label: 'admin', role: 'admin' })
      adminId = admin.id

      const [bundle] = await fixtures
        .db()
        .insert(setupBundles)
        .values({ name: `bundle-${fixtures.suffix}`, createdByUserId: adminId })
        .returning({ id: setupBundles.id })
      const [bundleVersion] = await fixtures
        .db()
        .insert(setupBundleVersions)
        .values({
          setupBundleId: bundle.id,
          version: 1,
          s3Key: `fixtures/${fixtures.suffix}.tar.gz`,
          contentDigest: 'a'.repeat(64),
          sizeBytes: 1,
          registeredByUserId: adminId,
        })
        .returning({ id: setupBundleVersions.id })
      const [workspace] = await fixtures
        .db()
        .insert(workspaces)
        .values({ name: `workspace-${fixtures.suffix}` })
        .returning({ id: workspaces.id })
      const [workspaceVersion] = await fixtures
        .db()
        .insert(workspaceVersions)
        .values({ workspaceId: workspace.id, version: 1, createdByUserId: adminId })
        .returning({ id: workspaceVersions.id })
      const [profile] = await fixtures
        .db()
        .insert(executionProfiles)
        .values({ name: `profile-${fixtures.suffix}`, enabled: true })
        .returning({ id: executionProfiles.id })
      const [version] = await fixtures
        .db()
        .insert(executionProfileVersions)
        .values({
          executionProfileId: profile.id,
          version: 1,
          workspaceVersionId: workspaceVersion.id,
          setupBundleVersionId: bundleVersion.id,
          model: 'claude-sonnet-5',
          instanceType: 'm7i.large',
          purchaseMode: 'spot',
          defaultWorkflowType: 'delegated',
          promptPreamble: 'The contract lives in packages/contracts.',
          createdByUserId: adminId,
        })
        .returning({ id: executionProfileVersions.id })
      await fixtures
        .db()
        .update(executionProfiles)
        .set({ currentVersionId: version.id })
        .where(eq(executionProfiles.id, profile.id))

      executionProfileId = profile.id
    }, 120_000)

    afterAll(async () => {
      await fixtures.close()
    })

    it('never returns the credential reference from a read', async () => {
      const created = await insertIntegration(fixtures.db(), values())

      expect(JSON.stringify(await findIntegration(fixtures.db(), created.id))).not.toContain('arn:')
      expect(
        JSON.stringify(await findIntegrationByName(fixtures.db(), created.name)),
      ).not.toContain('arn:')
    })

    it('hands the credential reference out only through readConnectorTarget', async () => {
      const created = await insertIntegration(fixtures.db(), values())
      const target = await readConnectorTarget(fixtures.db(), created.id)

      expect(target?.credentialSecretArn).toContain('arn:fixture:secret')
    })

    it('replaces mappings wholesale rather than diffing them', async () => {
      const created = await insertIntegration(fixtures.db(), values())

      await replaceMappings(fixtures.db(), created.id, [
        { position: 0, criteria: { issueType: 'Bug' }, executionProfileId, isDefault: false },
        { position: 1, criteria: {}, executionProfileId, isDefault: true },
      ])
      await replaceMappings(fixtures.db(), created.id, [
        { position: 0, criteria: { issueType: 'Story' }, executionProfileId, isDefault: false },
      ])

      const mappings = await readContractMappings(fixtures.db(), created.id)
      expect(mappings).toHaveLength(1)
      expect(mappings[0].criteria).toEqual({ issueType: 'Story' })
    })

    it('clears the mappings when handed an empty set, without a stale unique-position collision', async () => {
      const created = await insertIntegration(fixtures.db(), values())

      await replaceMappings(fixtures.db(), created.id, [
        { position: 0, criteria: {}, executionProfileId, isDefault: true },
      ])
      await replaceMappings(fixtures.db(), created.id, [])
      await replaceMappings(fixtures.db(), created.id, [
        { position: 0, criteria: {}, executionProfileId, isDefault: true },
      ])

      expect(await readContractMappings(fixtures.db(), created.id)).toHaveLength(1)
    })

    it('reads the profile preamble off the current version (FR-157)', async () => {
      expect(await readProfilePreamble(fixtures.db(), executionProfileId)).toBe(
        'The contract lives in packages/contracts.',
      )
    })

    it('reports a profile it cannot resolve as undefined rather than as an empty preamble', async () => {
      expect(
        await readProfilePreamble(fixtures.db(), '11111111-1111-4111-8111-111111111111'),
      ).toBeUndefined()
    })

    it('lists runs newest first', async () => {
      const created = await insertIntegration(fixtures.db(), values())
      await fixtures
        .db()
        .insert(integrationRuns)
        .values({ integrationId: created.id, trigger: 'scheduled' })
      const [second] = await fixtures
        .db()
        .insert(integrationRuns)
        .values({ integrationId: created.id, trigger: 'manual' })
        .returning({ id: integrationRuns.id })

      const page = await listRuns(fixtures.db(), { integrationId: created.id, limit: 10 })

      expect(page.items[0].id).toBe(second.id)
      expect((await findLatestRun(fixtures.db(), created.id))?.trigger).toBe('manual')
    })

    it('counts what a deletion would take with it', async () => {
      const created = await insertIntegration(fixtures.db(), values())
      await fixtures
        .db()
        .insert(ticketClaims)
        .values({ integrationId: created.id, externalId: 'FIX-3' })

      expect(await readIntegrationReferences(fixtures.db(), created.id)).toEqual({
        claimedTicketCount: 1,
        startedWorkflowCount: 0,
        deletable: false,
      })
    })

    it('deletes an integration with its mappings and run history', async () => {
      const created = await insertIntegration(fixtures.db(), values())
      await replaceMappings(fixtures.db(), created.id, [
        { position: 0, criteria: {}, executionProfileId, isDefault: true },
      ])
      await fixtures
        .db()
        .insert(integrationRuns)
        .values({ integrationId: created.id, trigger: 'scheduled' })

      await deleteIntegration(fixtures.db(), created.id)

      expect(await findIntegration(fixtures.db(), created.id)).toBeUndefined()
      expect(await readContractMappings(fixtures.db(), created.id)).toEqual([])
    })

    it('paginates by keyset, newest first', async () => {
      await insertIntegration(fixtures.db(), values())
      await insertIntegration(fixtures.db(), values())

      const first = await listIntegrations(fixtures.db(), { enabledOnly: false, limit: 1 })

      expect(first.items).toHaveLength(1)
      expect(first.nextCursor).toBeDefined()

      const second = await listIntegrations(fixtures.db(), {
        enabledOnly: false,
        limit: 1,
        cursor: first.nextCursor,
      })

      expect(second.items[0]?.id).not.toBe(first.items[0].id)
    })

    it('filters to enabled integrations when asked', async () => {
      const created = await insertIntegration(fixtures.db(), values())
      await updateIntegration(fixtures.db(), created.id, { enabled: true })

      const page = await listIntegrations(fixtures.db(), { enabledOnly: true, limit: 50 })

      expect(page.items.every((item) => item.enabled)).toBe(true)
      expect(page.items.map((item) => item.id)).toContain(created.id)
    })
  },
)
