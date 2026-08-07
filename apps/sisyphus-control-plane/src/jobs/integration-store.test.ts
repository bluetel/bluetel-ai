import {
  integrationRuns,
  ticketClaims,
  workflowEvents,
  workflows,
} from '@bluetel-ai/sisyphus-api/db'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createIntegrationFixtures, readTestDatabaseUrl } from './integration-fixtures'
import type { ClaimAndStartInput, ProfileLaunch } from './integration-store'
import {
  claimAndStart,
  closeRun,
  countStartedSince,
  findCompetingClaim,
  findIntegration,
  findLastCompletedRun,
  findOpenRun,
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

  describe('findCompetingClaim (FR-104)', () => {
    it('finds a claim held by another integration on the same board', async () => {
      const first = await fixtures.seedIntegration({ name: `a-${fixtures.suffix}` })
      const second = await fixtures.seedIntegration({ name: `b-${fixtures.suffix}` })
      await claimAndStart(fixtures.db(), await claimInput(first.id))

      expect(
        await findCompetingClaim(fixtures.db(), {
          integrationId: second.id,
          externalId: 'FIX-1',
          baseUrl: second.baseUrl,
          projectPrefix: second.projectPrefix,
        }),
      ).toMatchObject({ integrationId: first.id })
    })

    it('ignores a claim on a different board with the same ticket key', async () => {
      const first = await fixtures.seedIntegration({
        name: `a-${fixtures.suffix}`,
        baseUrl: 'https://one.invalid',
      })
      const second = await fixtures.seedIntegration({
        name: `b-${fixtures.suffix}`,
        baseUrl: 'https://two.invalid',
      })
      await claimAndStart(fixtures.db(), await claimInput(first.id))

      expect(
        await findCompetingClaim(fixtures.db(), {
          integrationId: second.id,
          externalId: 'FIX-1',
          baseUrl: second.baseUrl,
          projectPrefix: second.projectPrefix,
        }),
      ).toBeUndefined()
    })

    it('never reports the caller as its own competitor', async () => {
      const integration = await fixtures.seedIntegration()
      await claimAndStart(fixtures.db(), await claimInput(integration.id))

      expect(
        await findCompetingClaim(fixtures.db(), {
          integrationId: integration.id,
          externalId: 'FIX-1',
          baseUrl: integration.baseUrl,
          projectPrefix: integration.projectPrefix,
        }),
      ).toBeUndefined()
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
  })
})
