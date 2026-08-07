import {
  integrationRuns,
  integrations,
  ticketClaims,
  workflowEvents,
  workflows,
} from '@bluetel-ai/sisyphus-api/db'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  createIntegrationFixtures,
  FIXTURE_SPEND_CAP,
  FIXTURE_TURN_CAP,
  readTestDatabaseUrl,
} from './integration-fixtures'
import type { ClaimAndStartInput, ProfileLaunch } from './integration-store'
import {
  claimAndStart,
  closeRun,
  countStartedSince,
  findIntegration,
  findLastCompletedRun,
  findOpenRun,
  findTicketOwner,
  listIntegrations,
  listMappings,
  openRun,
  readProfileLaunch,
  resolveOwnerUserId,
} from './integration-store'

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

describeWithDatabase('the integration store (T117)', () => {
  const fixtures = createIntegrationFixtures(connectionString ?? '')

  beforeAll(async () => {
    await fixtures.open()
  }, 120_000)

  afterAll(async () => {
    await fixtures.close()
  })

  afterEach(async () => {
    await fixtures.removeAll()
  })

  const launchFor = async (): Promise<ProfileLaunch> => {
    const profile = await readProfileLaunch(fixtures.db(), fixtures.executionProfileId())
    if (profile === undefined) throw new Error('the fixture profile has no published version')
    return profile
  }

  const claimInput = async (
    integrationId: string,
    overrides: Partial<ClaimAndStartInput> = {},
  ): Promise<ClaimAndStartInput> => ({
    integrationId,
    externalId: 'FIX-1',
    mappingId: await fixtures.seedMapping({ integrationId }),
    ownerUserId: fixtures.ownerUserId(),
    ticketUrl: 'https://boards.invalid/browse/FIX-1',
    assembledPrompt: '## TASK\n\nfix the basket\n',
    promptTruncated: false,
    profile: await launchFor(),
    ...overrides,
  })

  describe('reads', () => {
    it('finds an integration and reports an absent one as undefined', async () => {
      const integration = await fixtures.seedIntegration()

      expect((await findIntegration(fixtures.db(), integration.id))?.id).toBe(integration.id)
      expect(
        await findIntegration(fixtures.db(), '11111111-1111-4111-8111-111111111111'),
      ).toBeUndefined()
    })

    it('lists integrations by id, so a sweep is deterministic', async () => {
      await fixtures.seedIntegration({ name: `b-${fixtures.suffix}` })
      await fixtures.seedIntegration({ name: `a-${fixtures.suffix}` })

      const ids = (await listIntegrations(fixtures.db())).map((row) => row.id)

      expect([...ids].sort()).toEqual(ids)
    })

    it('orders mappings by position, because first match is the configuration (FR-130)', async () => {
      const integration = await fixtures.seedIntegration()
      await fixtures.seedMapping({ integrationId: integration.id, position: 2, criteria: { a: 1 } })
      await fixtures.seedMapping({ integrationId: integration.id, position: 0, criteria: { b: 2 } })

      expect(
        (await listMappings(fixtures.db(), integration.id)).map((row) => row.position),
      ).toEqual([0, 2])
    })

    it('reads the launch values off the profile version, not off the profile (FR-126)', async () => {
      await fixtures.seedIntegration()
      const profile = await launchFor()

      expect(profile.model).toBe('claude-sonnet-5')
      expect(profile.promptPreamble).toBe('The contract lives in packages/contracts.')
      expect(profile.executionProfileVersionId).not.toBe(profile.executionProfileId)
    })

    it('reports a profile with no published version as absent rather than as half a profile', async () => {
      await fixtures.seedIntegration()

      expect(
        await readProfileLaunch(fixtures.db(), '11111111-1111-4111-8111-111111111111'),
      ).toBeUndefined()
    })
  })

  describe('run records (FR-103, FR-105)', () => {
    it('opens a run before discovery, so a tick that dies leaves a trace', async () => {
      const integration = await fixtures.seedIntegration()
      const run = await openRun(fixtures.db(), {
        integrationId: integration.id,
        trigger: 'scheduled',
      })

      expect(run.endedAt).toBeNull()
      expect((await findOpenRun(fixtures.db(), integration.id))?.id).toBe(run.id)
    })

    it('stops reporting a run as open once it is closed', async () => {
      const integration = await fixtures.seedIntegration()
      const run = await openRun(fixtures.db(), { integrationId: integration.id, trigger: 'manual' })

      await closeRun(fixtures.db(), run.id, {
        examinedCount: 3,
        matchedCount: 2,
        startedCount: 1,
        skipReasons: [{ externalId: 'FIX-2', reason: 'ceiling_reached' }],
      })

      expect(await findOpenRun(fixtures.db(), integration.id)).toBeUndefined()
    })

    it('derives the skipped count from the reasons, so the two cannot disagree', async () => {
      const integration = await fixtures.seedIntegration()
      const run = await openRun(fixtures.db(), {
        integrationId: integration.id,
        trigger: 'scheduled',
      })

      await closeRun(fixtures.db(), run.id, {
        examinedCount: 2,
        matchedCount: 2,
        startedCount: 0,
        skipReasons: [
          { externalId: 'FIX-1', reason: 'empty_item' },
          { externalId: 'FIX-2', reason: 'ceiling_reached' },
        ],
      })

      const [row] = await fixtures
        .db()
        .select()
        .from(integrationRuns)
        .where(eq(integrationRuns.id, run.id))

      expect(row.skippedCount).toBe(2)
      expect(row.error).toBeNull()
    })

    it('finds the most recent run, closed or not', async () => {
      const integration = await fixtures.seedIntegration()
      await openRun(fixtures.db(), { integrationId: integration.id, trigger: 'scheduled' })
      const second = await openRun(fixtures.db(), {
        integrationId: integration.id,
        trigger: 'manual',
      })

      expect((await findLastCompletedRun(fixtures.db(), integration.id))?.id).toBe(second.id)
    })
  })

  describe('ownership (FR-132, FR-133, FR-191)', () => {
    it('prefers the assignee, matched case-insensitively', async () => {
      const integration = await fixtures.seedIntegration()
      const assigneeId = await fixtures.seedUser('assignee@sisyphus.test')

      expect(
        await resolveOwnerUserId(fixtures.db(), {
          assigneeEmail: ' Assignee@Sisyphus.Test ',
          defaultOwnerUserId: integration.defaultOwnerUserId,
        }),
      ).toBe(assigneeId)
    })

    it('falls back to the default owner for an unknown assignee', async () => {
      const integration = await fixtures.seedIntegration()

      expect(
        await resolveOwnerUserId(fixtures.db(), {
          assigneeEmail: 'stranger@example.invalid',
          defaultOwnerUserId: integration.defaultOwnerUserId,
        }),
      ).toBe(fixtures.ownerUserId())
    })

    it('reports no owner at all rather than picking one arbitrarily', async () => {
      await fixtures.seedIntegration()

      expect(
        await resolveOwnerUserId(fixtures.db(), {
          assigneeEmail: null,
          defaultOwnerUserId: null,
        }),
      ).toBeUndefined()
    })
  })

  describe('countStartedSince (FR-107)', () => {
    it('counts workflows this integration started, not run records', async () => {
      const integration = await fixtures.seedIntegration()
      await claimAndStart(fixtures.db(), await claimInput(integration.id))

      expect(
        await countStartedSince(fixtures.db(), integration.id, new Date(Date.now() - 60_000)),
      ).toBe(1)
    })

    it('excludes runs older than the window', async () => {
      const integration = await fixtures.seedIntegration()
      await claimAndStart(fixtures.db(), await claimInput(integration.id))

      expect(
        await countStartedSince(fixtures.db(), integration.id, new Date(Date.now() + 60_000)),
      ).toBe(0)
    })
  })

  /**
   * FR-102 is a rule about an interleaving, so this races the seam itself rather than two calls in
   * sequence. Remove `onConflictDoNothing` from `claimAndStart` and this fails with a unique
   * violation; replace the index with an application-level "does a claim exist" check and it fails
   * with two workflows.
   */
  describe('claimAndStart is exactly-once (FR-102, R8)', () => {
    it('inserts the claim and the workflow together', async () => {
      const integration = await fixtures.seedIntegration()
      const outcome = await claimAndStart(fixtures.db(), await claimInput(integration.id))

      if (outcome.outcome !== 'started') throw new Error('the claim was refused')

      const [claim] = await fixtures
        .db()
        .select()
        .from(ticketClaims)
        .where(eq(ticketClaims.id, outcome.claimId))

      expect(claim.workflowId).toBe(outcome.workflowId)
      expect(await fixtures.countWorkflows()).toBe(1)
    })

    it('attributes the timeline entry to the integration, not to a person', async () => {
      const integration = await fixtures.seedIntegration()
      const outcome = await claimAndStart(fixtures.db(), await claimInput(integration.id))
      if (outcome.outcome !== 'started') throw new Error('the claim was refused')

      const [event] = await fixtures
        .db()
        .select()
        .from(workflowEvents)
        .where(eq(workflowEvents.workflowId, outcome.workflowId))

      expect(event.actorType).toBe('integration')
      expect(event.actorUserId).toBeNull()
    })

    it('stores the prompt as sent on the workflow row (FR-162)', async () => {
      const integration = await fixtures.seedIntegration()
      const outcome = await claimAndStart(
        fixtures.db(),
        await claimInput(integration.id, {
          assembledPrompt: '## TASK\n\nexactly this\n',
          promptTruncated: true,
        }),
      )
      if (outcome.outcome !== 'started') throw new Error('the claim was refused')

      expect(await fixtures.readWorkflowPrompt(outcome.workflowId)).toEqual({
        prompt: '## TASK\n\nexactly this\n',
        truncated: true,
      })
    })

    it('two concurrent claims on the same ticket produce exactly one workflow', async () => {
      const integration = await fixtures.seedIntegration()
      const input = await claimInput(integration.id)

      const outcomes = await Promise.all([
        claimAndStart(fixtures.db(), input),
        claimAndStart(fixtures.db(), input),
      ])

      expect(outcomes.filter((outcome) => outcome.outcome === 'started')).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome.outcome === 'already_claimed')).toHaveLength(1)
      expect(await fixtures.countWorkflows()).toBe(1)
      expect(await fixtures.countClaims()).toBe(1)
    })

    it('eight concurrent claims on the same ticket still produce exactly one workflow', async () => {
      const integration = await fixtures.seedIntegration()
      const input = await claimInput(integration.id)

      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => claimAndStart(fixtures.db(), input)),
      )

      expect(outcomes.filter((outcome) => outcome.outcome === 'started')).toHaveLength(1)
      expect(await fixtures.countWorkflows()).toBe(1)
    })

    it('names the workflow the winner started, so the loser can report it', async () => {
      const integration = await fixtures.seedIntegration()
      const input = await claimInput(integration.id)

      const first = await claimAndStart(fixtures.db(), input)
      const second = await claimAndStart(fixtures.db(), input)

      if (first.outcome !== 'started') throw new Error('the first claim was refused')
      expect(second).toEqual({ outcome: 'already_claimed', workflowId: first.workflowId })
    })

    it('lets the same ticket key be claimed by an integration on a different board', async () => {
      const first = await fixtures.seedIntegration({ name: `a-${fixtures.suffix}` })
      const second = await fixtures.seedIntegration({ name: `b-${fixtures.suffix}` })

      await claimAndStart(fixtures.db(), await claimInput(first.id))
      const outcome = await claimAndStart(fixtures.db(), await claimInput(second.id))

      expect(outcome.outcome).toBe('started')
      expect(await fixtures.countWorkflows()).toBe(2)
    })
  })

  /**
   * FR-104 asks for a winner that is **deterministic and independent of tick timing**, so every
   * test here fixes the two rows and asks the question from both sides. A guard that answered
   * "whoever claimed first" would pass the claim cases and fail the two below them.
   */
  describe('findTicketOwner (FR-104)', () => {
    /** The two seeded integrations, sorted by the rule so a test never depends on uuid luck. */
    const twoOnOneBoard = async (
      options: { readonly baseUrls?: readonly [string, string] } = {},
    ) => {
      const a = await fixtures.seedIntegration({
        name: `a-${fixtures.suffix}`,
        ...(options.baseUrls === undefined ? {} : { baseUrl: options.baseUrls[0] }),
      })
      const b = await fixtures.seedIntegration({
        name: `b-${fixtures.suffix}`,
        ...(options.baseUrls === undefined ? {} : { baseUrl: options.baseUrls[1] }),
      })

      return a.id < b.id ? { lower: a, higher: b } : { lower: b, higher: a }
    }

    const ownerFor = (integration: { id: string; baseUrl: string; projectPrefix: string }) =>
      findTicketOwner(fixtures.db(), {
        integrationId: integration.id,
        externalId: 'FIX-1',
        baseUrl: integration.baseUrl,
        projectPrefix: integration.projectPrefix,
      })

    it('awards the ticket to the lowest-id enabled integration before anyone has claimed', async () => {
      // The branch the old guard had no answer for: nothing is claimed, so a claim lookup finds
      // nothing and the higher-id integration would have gone ahead — making the winner whichever
      // schedule fired first.
      const { higher, lower } = await twoOnOneBoard()

      expect(await ownerFor(higher)).toStrictEqual({
        integrationId: lower.id,
        workflowId: null,
        reason: 'lower_integration_id',
      })
    })

    it('lets the lowest-id integration through, whichever of them asks first', async () => {
      const { lower } = await twoOnOneBoard()

      expect(await ownerFor(lower)).toBeUndefined()
    })

    it('still refuses the lower-id integration once a run exists, rather than double-spending', async () => {
      // The other branch, and the reason the claim lookup stays first: a run started by the
      // higher-id integration — before this rule existed, say — cannot be un-started by a rule.
      const { higher, lower } = await twoOnOneBoard()
      await claimAndStart(fixtures.db(), await claimInput(higher.id))

      const owner = await ownerFor(lower)

      expect(owner?.integrationId).toBe(higher.id)
      expect(owner?.reason).toBe('already_started')
      // Named, so the record can point at the run rather than merely at the integration.
      expect(typeof owner?.workflowId).toBe('string')
    })

    it('names the claimant when the lowest-id integration is the one that already started it', async () => {
      const { higher, lower } = await twoOnOneBoard()
      await claimAndStart(fixtures.db(), await claimInput(lower.id))

      expect(await ownerFor(higher)).toMatchObject({
        integrationId: lower.id,
        reason: 'already_started',
      })
    })

    it('ignores a disabled sibling, because FR-104 is about two enabled integrations', async () => {
      const { higher, lower } = await twoOnOneBoard()
      await fixtures
        .db()
        .update(integrations)
        .set({ enabled: false })
        .where(eq(integrations.id, lower.id))

      expect(await ownerFor(higher)).toBeUndefined()
    })

    it('ignores an integration on a different board with the same ticket key', async () => {
      const { higher } = await twoOnOneBoard({
        baseUrls: ['https://one.invalid', 'https://two.invalid'],
      })

      expect(await ownerFor(higher)).toBeUndefined()
    })

    it('never reports the caller as its own competitor', async () => {
      const integration = await fixtures.seedIntegration()
      await claimAndStart(fixtures.db(), await claimInput(integration.id))

      expect(await ownerFor(integration)).toBeUndefined()
    })
  })

  describe('workflows started by an integration', () => {
    it('are queued, unattributed to a person, and pinned to the profile version', async () => {
      const integration = await fixtures.seedIntegration()
      const outcome = await claimAndStart(fixtures.db(), await claimInput(integration.id))
      if (outcome.outcome !== 'started') throw new Error('the claim was refused')

      const [row] = await fixtures
        .db()
        .select()
        .from(workflows)
        .where(eq(workflows.id, outcome.workflowId))

      expect(row.state).toBe('queued')
      expect(row.initiatedByUserId).toBeNull()
      expect(row.executionProfileVersionId).toBe((await launchFor()).executionProfileVersionId)
      expect(row.ticketReference).toBe('https://boards.invalid/browse/FIX-1')
    })

    it('carry every launch value the resolved profile version specifies (FR-101, T186)', async () => {
      // FR-101: the run **inherits** its workspace, setup bundle, model, instance size and caps.
      // All seven are asserted together rather than the interesting-looking three, because the two
      // nullable ones — `turn_cap` and `spend_cap` — are the ones a dropped column leaves silently
      // null. Delete either from `claimAndStart`'s insert and this is the test that goes red; the
      // other five are `not null` and would take the whole suite down with a constraint violation.
      const integration = await fixtures.seedIntegration()
      const profile = await launchFor()
      const outcome = await claimAndStart(fixtures.db(), await claimInput(integration.id))
      if (outcome.outcome !== 'started') throw new Error('the claim was refused')

      const [row] = await fixtures
        .db()
        .select({
          workspaceVersionId: workflows.workspaceVersionId,
          setupBundleVersionId: workflows.setupBundleVersionId,
          model: workflows.model,
          instanceType: workflows.instanceType,
          purchaseMode: workflows.purchaseMode,
          turnCap: workflows.turnCap,
          spendCap: workflows.spendCap,
        })
        .from(workflows)
        .where(eq(workflows.id, outcome.workflowId))

      expect(row).toStrictEqual({
        workspaceVersionId: profile.workspaceVersionId,
        setupBundleVersionId: profile.setupBundleVersionId,
        model: profile.model,
        instanceType: profile.instanceType,
        purchaseMode: profile.purchaseMode,
        turnCap: profile.turnCap,
        spendCap: profile.spendCap,
      })

      // And the caps are genuinely present, so the assertion above is comparing two values rather
      // than two nulls — which is how a missing column would have slipped through it.
      expect(row.turnCap).toBe(FIXTURE_TURN_CAP)
      expect(row.spendCap).toBe(FIXTURE_SPEND_CAP)
    })
  })
})
