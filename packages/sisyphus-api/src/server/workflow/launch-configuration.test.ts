import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase, Workflow } from '../../db'
import { workflows } from '../../db'
import { listWorkflowsInput } from '../../schemas'
import { profilesRouter } from '../admin/profiles'
import type { SisyphusContext } from '../context'
import { createCallerFactory } from '../procedures'
import type { ResolvedScope } from '../scope'
import { memoiseScope } from '../scope'

import {
  loadLaunchConfiguration,
  readLaunchConfiguration,
  reconstructLaunchConfiguration,
} from './launch-configuration'
import { listWorkflows, readWorkflowDetail } from './queries'
import type { TwoProfileFixture, TwoProfileIds } from './test-support'
import { createTwoProfileFixture, LOCKED_FIELD_A, readTestDatabaseUrl } from './test-support'

/**
 * **SC-021 (T188).** A completed run's bootstrap must stay reconstructable for the whole retention
 * period — and until this module existed, it was not: the read path joined the *mutable* profile
 * row and never the version the run pinned, so editing a profile rewrote history for every run
 * launched under it, silently.
 *
 * The database suite below is the requirement stated literally: launch, complete, edit the profile
 * out from under the finished run, read it back, and assert it reads back as what it launched with
 * rather than as what the profile says now. It fails against the old read path, which is the only
 * reason it is worth having.
 */

const connectionString = readTestDatabaseUrl()

/** A complete `workflows` row, so the pure tests below construct one rather than casting to it. */
const workflowRow = (overrides: Partial<Workflow> = {}): Workflow => ({
  id: 'workflow-1',
  type: 'delegated',
  state: 'succeeded',
  terminalOutcome: 'succeeded',
  outcomeReason: null,
  initiatedByUserId: 'alice',
  originatingIntegrationId: null,
  originatingMappingId: null,
  ownerUserId: 'alice',
  executionProfileId: 'profile-1',
  executionProfileVersionId: 'version-1',
  setupBundleVersionId: 'bundle-version-1',
  workspaceVersionId: 'workspace-version-1',
  ticketReference: 'ACME-1',
  resultBranchName: 'sisyphus/acme-1',
  assembledPrompt: 'Preamble.\n\nFix the flaky test.',
  promptTruncated: false,
  model: 'claude-opus-5',
  instanceType: 'm7i.large',
  purchaseMode: 'spot',
  turnCap: 40,
  spendCap: '25.0000',
  turnsUsed: 3,
  spendUsed: '11.0000',
  computeCostBasis: null,
  predecessorWorkflowId: null,
  /** Null here because these rows predate the credential pool; 003/FR-059 sets it at admission. */
  agentCredentialId: null,
  sessionId: '00000000-0000-0000-0000-000000000001',
  currentSnapshotId: null,
  reviewerSummary: null,
  needsReassignment: false,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T01:00:00.000Z'),
  ...overrides,
})

describe('reconstructLaunchConfiguration', () => {
  const rows = {
    workflow: workflowRow(),
    pinnedProfileVersion: {
      version: 3,
      promptPreamble: 'Preamble as it was.',
      lockedFields: ['model'],
    },
    pinnedWorkspaceVersion: { version: 2, workspaceName: 'Platform (renamed)' },
    liveProfile: { name: 'Payments (legacy)', currentVersionId: 'version-7' },
  }

  it('takes every launch value from the run’s own write-once row (SC-021, FR-123)', () => {
    // Off the workflow rather than off the profile version, because an unlocked field may have
    // been overridden for this run alone and the version would not know (FR-123).
    const configuration = reconstructLaunchConfiguration({
      ...rows,
      workflow: workflowRow({ instanceType: 'm7i.24xlarge', turnCap: 5 }),
    })

    expect(configuration.pinned).toMatchObject({
      model: 'claude-opus-5',
      instanceType: 'm7i.24xlarge',
      purchaseMode: 'spot',
      turnCap: 5,
      spendCap: '25.0000',
      workspaceVersionId: 'workspace-version-1',
      setupBundleVersionId: 'bundle-version-1',
      workflowType: 'delegated',
      assembledPrompt: 'Preamble.\n\nFix the flaky test.',
    })
  })

  it('takes the preamble, the locked fields and the version number from the pinned version', () => {
    const configuration = reconstructLaunchConfiguration(rows)

    expect(configuration.pinned.executionProfileVersion).toBe(3)
    expect(configuration.pinned.executionProfileVersionId).toBe('version-1')
    expect(configuration.pinned.promptPreamble).toBe('Preamble as it was.')
    expect(configuration.pinned.lockedFields).toStrictEqual(['model'])
    expect(configuration.pinned.workspaceVersion).toBe(2)
  })

  it('keeps the live names apart from the pinned values rather than beside them', () => {
    const configuration = reconstructLaunchConfiguration(rows)

    // The current name, for display continuity — and reachable only through `live`, so a caller
    // cannot mistake it for something the run was configured with.
    expect(configuration.live).toStrictEqual({
      executionProfileName: 'Payments (legacy)',
      workspaceName: 'Platform (renamed)',
    })
    expect(Object.keys(configuration.pinned)).not.toContain('executionProfileName')
    expect(Object.keys(configuration.pinned)).not.toContain('workspaceName')
  })

  it('says when the profile has moved on since the run launched', () => {
    expect(reconstructLaunchConfiguration(rows).profileEditedSinceLaunch).toBe(true)

    const unedited = reconstructLaunchConfiguration({
      ...rows,
      liveProfile: { name: 'Payments', currentVersionId: 'version-1' },
    })
    expect(unedited.profileEditedSinceLaunch).toBe(false)
  })

  it('reports an ad hoc run as pinned to no profile, not as an edited one (FR-126, FR-129)', () => {
    const configuration = reconstructLaunchConfiguration({
      ...rows,
      workflow: workflowRow({ executionProfileId: null, executionProfileVersionId: null }),
      pinnedProfileVersion: undefined,
      liveProfile: undefined,
    })

    expect(configuration.pinned.executionProfileId).toBeNull()
    expect(configuration.pinned.executionProfileVersionId).toBeNull()
    expect(configuration.pinned.executionProfileVersion).toBeNull()
    expect(configuration.pinned.lockedFields).toStrictEqual([])
    expect(configuration.live.executionProfileName).toBeNull()
    // There is no version for an edit to have moved past, so "edited since" would be a lie.
    expect(configuration.profileEditedSinceLaunch).toBe(false)
  })
})

describe.skipIf(connectionString === undefined)(
  'a completed run reads back as it was launched (SC-021)',
  () => {
    let fixture: TwoProfileFixture
    let db: SisyphusDatabase
    let ids: TwoProfileIds
    let aliceScope: ResolvedScope
    let adminScope: ResolvedScope

    /** The profile as it will be *after* the edit. Every value disagrees with the run's pin. */
    const editedName = () => `renamed-a-${ids.a.executionProfileId.slice(0, 8)}`

    const adminContext = (): SisyphusContext => {
      const session = {
        user: {
          id: ids.admin,
          email: 'admin@sisyphus.test',
          displayName: 'Admin',
          role: 'admin' as const,
          isActive: true,
        },
        expiresAt: new Date(Date.now() + 60_000),
      }

      return {
        headers: new Headers(),
        dependencies: {
          db,
          resolveSession: () => Promise.resolve(session),
          resolveMachineCredential: () => Promise.resolve(null),
          recordDenial: () => Promise.resolve(),
        },
        db,
        session,
        scope: memoiseScope(() => Promise.resolve(adminScope)),
        machineCredential: () => Promise.resolve(null),
        validationCredential: () => Promise.resolve(null),
      }
    }

    beforeAll(async () => {
      fixture = createTwoProfileFixture(connectionString ?? '')
      await fixture.open()
      db = fixture.db()
      ids = fixture.ids()
      aliceScope = await fixture.scopeFor(ids.alice)
      adminScope = await fixture.scopeFor(ids.admin, true)

      // 1. The run finishes. Everything below is a read of a *completed* run, which is the case
      //    SC-021 names — a run still in flight would keep its configuration for other reasons.
      await db
        .update(workflows)
        .set({ state: 'succeeded', terminalOutcome: 'succeeded' })
        .where(eq(workflows.id, ids.a.workflowId))

      // 2. And then somebody edits the profile it launched from, through the real admin path.
      const profiles = createCallerFactory(profilesRouter)(adminContext())

      await profiles.update({
        executionProfileId: ids.a.executionProfileId,
        name: editedName(),
        workspaceVersionId: ids.a.workspaceVersionId,
        setupBundleVersionId: ids.bundleVersion,
        model: 'claude-sonnet-5',
        instanceType: 'm7i.24xlarge',
        purchaseMode: 'on_demand',
        turnCap: 400,
        spendCap: '900.0000',
        defaultWorkflowType: 'autonomous',
        promptPreamble: 'Rewritten preamble.',
        lockedFields: [],
      })
    }, 60_000)

    afterAll(async () => {
      await fixture.close()
    }, 30_000)

    it('reconstructs the run’s configuration from the version it pinned, not the current one', async () => {
      const configuration = await readLaunchConfiguration({
        db,
        scope: aliceScope,
        workflowId: ids.a.workflowId,
      })

      expect(configuration.pinned).toMatchObject({
        executionProfileId: ids.a.executionProfileId,
        executionProfileVersionId: ids.a.executionProfileVersionId,
        executionProfileVersion: 1,
        workspaceVersionId: ids.a.workspaceVersionId,
        setupBundleVersionId: ids.bundleVersion,
        model: 'claude-opus-5',
        instanceType: 'm7i.large',
        purchaseMode: 'spot',
        promptPreamble: 'Preamble A',
        lockedFields: [LOCKED_FIELD_A],
      })

      // Stated as its own assertion because these are the values the broken read path returned:
      // version 2's, belonging to an edit that happened after this run had already finished.
      expect(configuration.pinned.instanceType).not.toBe('m7i.24xlarge')
      expect(configuration.pinned.model).not.toBe('claude-sonnet-5')
      expect(configuration.pinned.promptPreamble).not.toBe('Rewritten preamble.')
      expect(configuration.pinned.lockedFields).not.toStrictEqual([])
      expect(configuration.pinned.executionProfileVersion).not.toBe(2)
    })

    it('shows the profile’s current name, and says the profile has been edited since', async () => {
      const configuration = await readLaunchConfiguration({
        db,
        scope: aliceScope,
        workflowId: ids.a.workflowId,
      })

      // The name is display continuity, so it is the current one — deliberately, and separately.
      expect(configuration.live.executionProfileName).toBe(editedName())
      // …and the panel is told that the number beside it is not the profile's latest.
      expect(configuration.profileEditedSinceLaunch).toBe(true)
    })

    it('carries the reconstruction on the detail read the panel makes (FR-014, SC-021)', async () => {
      const detail = await readWorkflowDetail({
        db,
        scope: aliceScope,
        workflowId: ids.a.workflowId,
      })

      expect(detail.launchConfiguration.pinned.executionProfileVersion).toBe(1)
      expect(detail.launchConfiguration.pinned.promptPreamble).toBe('Preamble A')
      // The detail's own `executionProfileName` is the live one, and stays that way.
      expect(detail.executionProfileName).toBe(editedName())
      expect(detail.launchConfiguration.live.executionProfileName).toBe(editedName())
    })

    it('shows the pinned version on the list row too, beside the current name (FR-012)', async () => {
      const page = await listWorkflows({
        db,
        scope: aliceScope,
        input: listWorkflowsInput.parse({}),
      })

      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({
        id: ids.a.workflowId,
        executionProfileName: editedName(),
        executionProfileVersion: 1,
      })
    })

    it('answers an ad hoc run with no version rather than with the profile’s (FR-126, FR-129)', async () => {
      const [adHoc] = await db
        .insert(workflows)
        .values({
          type: 'delegated',
          state: 'succeeded',
          terminalOutcome: 'succeeded',
          ownerUserId: ids.alice,
          initiatedByUserId: ids.admin,
          setupBundleVersionId: ids.bundleVersion,
          workspaceVersionId: ids.a.workspaceVersionId,
          model: 'claude-sonnet-5',
          instanceType: 'ad.hoc',
          purchaseMode: 'on_demand',
          sessionId: randomUUID(),
        })
        .returning({ id: workflows.id })

      const configuration = await readLaunchConfiguration({
        db,
        scope: adminScope,
        workflowId: adHoc.id,
      })

      expect(configuration.pinned.executionProfileVersionId).toBeNull()
      expect(configuration.pinned.executionProfileVersion).toBeNull()
      expect(configuration.pinned.instanceType).toBe('ad.hoc')
      expect(configuration.live.executionProfileName).toBeNull()
      expect(configuration.profileEditedSinceLaunch).toBe(false)

      await db.delete(workflows).where(eq(workflows.id, adHoc.id))
    })

    it('refuses a run the caller may not see, exactly as every other read does (FR-190)', async () => {
      await expect(
        readLaunchConfiguration({ db, scope: aliceScope, workflowId: ids.b.workflowId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      await expect(
        readLaunchConfiguration({ db, scope: aliceScope, workflowId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('is the same answer whether reached by id or from a row already read', async () => {
      // `loadLaunchConfiguration` is the unscoped half, and it must not drift from the scoped one.
      const [row] = await db.select().from(workflows).where(eq(workflows.id, ids.a.workflowId))

      await expect(loadLaunchConfiguration(db, row)).resolves.toStrictEqual(
        await readLaunchConfiguration({ db, scope: aliceScope, workflowId: ids.a.workflowId }),
      )
    })
  },
)
