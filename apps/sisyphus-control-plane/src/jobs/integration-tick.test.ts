import type { CandidateItem } from '@bluetel-ai/sisyphus-api/contracts'
import { integrationRuns, ticketClaims, workflows } from '@bluetel-ai/sisyphus-api/db'
import { desc, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createFakeConnector, fakeCandidate, fakeConnectorFactory } from './connector-fake'
import { createConnectorRegistry } from './connector-registry'
import { createIntegrationFixtures, readTestDatabaseUrl } from './integration-fixtures'
import { DEFAULT_FAILURE_THRESHOLD } from './integration-health'
import type { IntegrationTickDependencies } from './integration-tick'
import { connectorConfigFor, integrationTick, runIntegrationTick } from './integration-tick'
import type { PromptRedactor } from './prompt-redact'

/* cspell:ignore AKIA AKIAFIXTUREONLY */

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

/** Stands in for the executor's redactor; the standard itself is asserted in `prompt-redact.test.ts`. */
const redactor: PromptRedactor = {
  redact: (text) => text.replace(/\bAKIA[A-Z0-9]{16}\b/g, '[redacted:access-key-id]'),
}

const readCredential = () => Promise.resolve('board-credential-fixture')

describe('connectorConfigFor', () => {
  it('carries where the board is and what to look at, and nothing about scheduling (FR-096)', () => {
    const config = connectorConfigFor({
      baseUrl: 'https://boards.invalid',
      projectPrefix: 'FIX',
      label: 'sisyphus',
      extraFilters: { status: 'Ready' },
      cronExpression: '0/15 * * * *',
      perTickCeiling: 3,
      credentialSecretArn: 'arn:fixture',
    } as never)

    expect(config).toEqual({
      baseUrl: 'https://boards.invalid',
      projectPrefix: 'FIX',
      label: 'sisyphus',
      extraFilters: { status: 'Ready' },
    })
  })

  it('never carries the credential ARN, so a logged config cannot point at a secret', () => {
    const config = connectorConfigFor({
      baseUrl: 'https://boards.invalid',
      projectPrefix: 'FIX',
      label: 'sisyphus',
      extraFilters: null,
      credentialSecretArn: 'arn:aws:secretsmanager:eu-west-2:1:secret:board',
    } as never)

    expect(JSON.stringify(config)).not.toContain('secretsmanager')
  })
})

describeWithDatabase('the integration tick (T117, FR-102..FR-108, FR-130, FR-159..FR-164)', () => {
  const fixtures = createIntegrationFixtures(connectionString ?? '')

  const dependenciesWith = (
    items: readonly CandidateItem[],
    overrides: Partial<Parameters<typeof createFakeConnector>[0]> = {},
  ) => {
    const connector = createFakeConnector({ items, ...overrides })

    return {
      connector,
      dependencies: {
        db: fixtures.db(),
        connectors: createConnectorRegistry({ jira: fakeConnectorFactory(connector) }),
        readCredential,
        redactor,
      } satisfies IntegrationTickDependencies,
    }
  }

  beforeAll(async () => {
    await fixtures.open()
  }, 120_000)

  afterAll(async () => {
    await fixtures.close()
  })

  afterEach(async () => {
    await fixtures.removeAll()
  })

  it('starts exactly one workflow for a matched ticket and comments on it (FR-142)', async () => {
    const integration = await fixtures.seedIntegration()
    await fixtures.seedMapping({ integrationId: integration.id })
    const { connector, dependencies } = dependenciesWith([fakeCandidate()])

    const outcome = await integrationTick({ ...dependencies, integrationId: integration.id })

    expect(outcome.outcome).toBe('completed')
    expect(await fixtures.countWorkflows()).toBe(1)
    expect(connector.writeBacks.map((entry) => entry.event.kind)).toEqual(['picked_up'])
  })

  it('records the mapping that resolved it, so why a run got its settings is answerable (FR-131)', async () => {
    const integration = await fixtures.seedIntegration()
    const mappingId = await fixtures.seedMapping({ integrationId: integration.id })
    const { dependencies } = dependenciesWith([fakeCandidate()])

    await integrationTick({ ...dependencies, integrationId: integration.id })

    const [row] = await fixtures
      .db()
      .select({
        mappingId: workflows.originatingMappingId,
        integrationId: workflows.originatingIntegrationId,
        initiatedBy: workflows.initiatedByUserId,
        ownerUserId: workflows.ownerUserId,
      })
      .from(workflows)

    expect(row.mappingId).toBe(mappingId)
    expect(row.integrationId).toBe(integration.id)
    expect(row.initiatedBy).toBeNull()
    expect(row.ownerUserId).toBe(fixtures.ownerUserId())
  })

  it('stores the assembled prompt as sent, redacted, with every layer in order (FR-159, FR-162)', async () => {
    const integration = await fixtures.seedIntegration({
      promptIntro: 'Work from this board ships as one pull request.',
    })
    await fixtures.seedMapping({ integrationId: integration.id })
    const { dependencies } = dependenciesWith([
      fakeCandidate({
        body: 'Fails with AKIAFIXTUREONLY00000 in the logs.',
        comments: [
          {
            id: '1',
            authorIdentity: 'sisyphus',
            isPlatformAuthored: true,
            body: 'Sisyphus has picked this up.',
            createdAt: new Date(0),
          },
          {
            id: '2',
            authorIdentity: 'human',
            isPlatformAuthored: false,
            body: 'Still reproducing on staging.',
            createdAt: new Date(0),
          },
        ],
      }),
    ])

    const outcome = await integrationTick({ ...dependencies, integrationId: integration.id })
    if (outcome.outcome !== 'completed') throw new Error('the tick did not complete')

    const stored = await fixtures.readWorkflowPrompt(outcome.startedWorkflowIds[0])
    const prompt = stored?.prompt ?? ''

    expect(prompt).toContain('The contract lives in packages/contracts.')
    expect(prompt).toContain('Work from this board ships as one pull request.')
    expect(prompt).toContain('Still reproducing on staging.')
    // FR-161: the platform's own comment must not come back as task input.
    expect(prompt).not.toContain('Sisyphus has picked this up.')
    // FR-163: redacted before it was stored.
    expect(prompt).not.toContain('AKIAFIXTUREONLY00000')
    expect(prompt.indexOf('packages/contracts')).toBeLessThan(prompt.indexOf('one pull request'))
  })

  it('records truncation on the workflow row (FR-163)', async () => {
    const integration = await fixtures.seedIntegration()
    await fixtures.seedMapping({ integrationId: integration.id })
    const { dependencies } = dependenciesWith([fakeCandidate()], {
      parts: (item) => ({
        title: item.title,
        url: item.url,
        body: item.body,
        comments: ['kept'],
        truncatedComments: 4,
      }),
    })

    const outcome = await integrationTick({ ...dependencies, integrationId: integration.id })
    if (outcome.outcome !== 'completed') throw new Error('the tick did not complete')

    expect((await fixtures.readWorkflowPrompt(outcome.startedWorkflowIds[0]))?.truncated).toBe(true)
  })

  it('skips an unmatched ticket, records why, and says so on it (FR-130, FR-143)', async () => {
    const integration = await fixtures.seedIntegration()
    await fixtures.seedMapping({ integrationId: integration.id, criteria: { issueType: 'Bug' } })
    const { connector, dependencies } = dependenciesWith([
      fakeCandidate({ attributes: { issueType: 'Story' } }),
    ])

    const outcome = await integrationTick({ ...dependencies, integrationId: integration.id })
    if (outcome.outcome !== 'completed') throw new Error('the tick did not complete')

    expect(await fixtures.countWorkflows()).toBe(0)
    expect(outcome.skips[0].reason).toBe('no_mapping_matched')
    expect(connector.writeBacks[0].event).toMatchObject({
      kind: 'skipped',
      reason: 'no_mapping_matched',
    })
  })

  it('skips a ticket with neither title nor description (FR-164)', async () => {
    const integration = await fixtures.seedIntegration()
    await fixtures.seedMapping({ integrationId: integration.id })
    const { connector, dependencies } = dependenciesWith([
      fakeCandidate({ title: '   ', body: null }),
    ])

    const outcome = await integrationTick({ ...dependencies, integrationId: integration.id })
    if (outcome.outcome !== 'completed') throw new Error('the tick did not complete')

    expect(await fixtures.countWorkflows()).toBe(0)
    expect(outcome.skips[0].reason).toBe('empty_item')
    expect(connector.writeBacks[0].event).toMatchObject({ reason: 'empty_item' })
  })

  it('defers past the per-tick ceiling rather than dropping the item (FR-107)', async () => {
    const integration = await fixtures.seedIntegration({ perTickCeiling: 1 })
    await fixtures.seedMapping({ integrationId: integration.id })
    const { connector, dependencies } = dependenciesWith([
      fakeCandidate({ externalId: 'FIX-1' }),
      fakeCandidate({ externalId: 'FIX-2' }),
    ])

    const outcome = await integrationTick({ ...dependencies, integrationId: integration.id })
    if (outcome.outcome !== 'completed') throw new Error('the tick did not complete')

    expect(outcome.started).toBe(1)
    expect(outcome.matched).toBe(2)
    expect(outcome.skips[0]).toMatchObject({ externalId: 'FIX-2', reason: 'ceiling_reached' })
    expect(connector.writeBacks.map((entry) => entry.event.kind)).toEqual(['picked_up', 'skipped'])
  })

  it('counts the rolling-period ceiling against runs that exist, not against run records (FR-107)', async () => {
    const integration = await fixtures.seedIntegration({ rollingPeriodCeiling: 1 })
    await fixtures.seedMapping({ integrationId: integration.id })

    const first = dependenciesWith([fakeCandidate({ externalId: 'FIX-1' })])
    await integrationTick({ ...first.dependencies, integrationId: integration.id })

    const second = dependenciesWith([fakeCandidate({ externalId: 'FIX-2' })])
    const outcome = await integrationTick({ ...second.dependencies, integrationId: integration.id })
    if (outcome.outcome !== 'completed') throw new Error('the tick did not complete')

    expect(outcome.started).toBe(0)
    expect(outcome.skips[0].reason).toBe('ceiling_reached')
  })

  it('refuses to start a run nobody is accountable for (FR-132, FR-133)', async () => {
    const integration = await fixtures.seedIntegration({ withoutDefaultOwner: true })
    await fixtures.seedMapping({ integrationId: integration.id })
    const { dependencies } = dependenciesWith([fakeCandidate()])

    const outcome = await integrationTick({ ...dependencies, integrationId: integration.id })
    if (outcome.outcome !== 'completed') throw new Error('the tick did not complete')

    expect(await fixtures.countWorkflows()).toBe(0)
    expect(outcome.skips[0].detail).toContain('no default owner')
  })

  it('gives the run to the assignee when the platform knows them (FR-132)', async () => {
    const integration = await fixtures.seedIntegration()
    await fixtures.seedMapping({ integrationId: integration.id })
    const assigneeId = await fixtures.seedUser('assignee@sisyphus.test')
    const { dependencies } = dependenciesWith([
      fakeCandidate({ assigneeEmail: 'Assignee@Sisyphus.Test' }),
    ])

    await integrationTick({ ...dependencies, integrationId: integration.id })

    const [row] = await fixtures.db().select({ ownerUserId: workflows.ownerUserId }).from(workflows)
    expect(row.ownerUserId).toBe(assigneeId)
  })

  it('falls back to the default owner for an assignee the platform does not know (FR-133)', async () => {
    const integration = await fixtures.seedIntegration()
    await fixtures.seedMapping({ integrationId: integration.id })
    const { dependencies } = dependenciesWith([
      fakeCandidate({ assigneeEmail: 'stranger@example.invalid' }),
    ])

    await integrationTick({ ...dependencies, integrationId: integration.id })

    const [row] = await fixtures.db().select({ ownerUserId: workflows.ownerUserId }).from(workflows)
    expect(row.ownerUserId).toBe(fixtures.ownerUserId())
  })

  it('skips when the mapped profile is disabled rather than launching from it', async () => {
    const integration = await fixtures.seedIntegration()
    await fixtures.seedMapping({ integrationId: integration.id })
    await fixtures.disableProfile()
    const { dependencies } = dependenciesWith([fakeCandidate()])

    const outcome = await integrationTick({ ...dependencies, integrationId: integration.id })
    if (outcome.outcome !== 'completed') throw new Error('the tick did not complete')

    expect(await fixtures.countWorkflows()).toBe(0)
    expect(outcome.skips[0].detail).toContain('disabled')
  })

  it('does not run a disabled integration', async () => {
    const integration = await fixtures.seedIntegration({ enabled: false })
    const { dependencies } = dependenciesWith([fakeCandidate()])

    expect(await integrationTick({ ...dependencies, integrationId: integration.id })).toMatchObject(
      {
        outcome: 'not_run',
        reason: 'disabled',
      },
    )
  })

  it('does not invent a run for an integration that does not exist', async () => {
    const { dependencies } = dependenciesWith([])

    expect(
      await integrationTick({
        ...dependencies,
        integrationId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toMatchObject({ outcome: 'not_run', reason: 'unknown_integration' })
  })

  it('coalesces a tick that arrives while a previous one is open (FR-103)', async () => {
    const integration = await fixtures.seedIntegration()
    await fixtures.seedMapping({ integrationId: integration.id })
    const [open] = await fixtures
      .db()
      .insert(integrationRuns)
      .values({ integrationId: integration.id, trigger: 'scheduled' })
      .returning({ id: integrationRuns.id })

    const { connector, dependencies } = dependenciesWith([fakeCandidate()])
    const outcome = await integrationTick({ ...dependencies, integrationId: integration.id })

    expect(outcome).toMatchObject({
      outcome: 'not_run',
      reason: 'previous_tick_running',
      openRunId: open.id,
    })
    expect(connector.discoveries).toEqual([])
  })

  it('records the run with its counts and reasons (FR-105)', async () => {
    const integration = await fixtures.seedIntegration({ perTickCeiling: 1 })
    await fixtures.seedMapping({ integrationId: integration.id })
    const { dependencies } = dependenciesWith([
      fakeCandidate({ externalId: 'FIX-1' }),
      fakeCandidate({ externalId: 'FIX-2' }),
    ])

    await integrationTick({ ...dependencies, integrationId: integration.id, trigger: 'manual' })

    const [run] = await fixtures.db().select().from(integrationRuns)

    expect(run.trigger).toBe('manual')
    expect(run.examinedCount).toBe(2)
    expect(run.matchedCount).toBe(2)
    expect(run.startedCount).toBe(1)
    expect(run.skippedCount).toBe(1)
    expect(run.endedAt).not.toBeNull()
    expect(run.skipReasons).toMatchObject([{ externalId: 'FIX-2', reason: 'ceiling_reached' }])
  })

  it('records an unreachable board as a failed run and counts it (FR-108)', async () => {
    const integration = await fixtures.seedIntegration()
    await fixtures.seedMapping({ integrationId: integration.id })
    const { dependencies } = dependenciesWith([], {
      discoverError: new Error('board unreachable'),
    })

    const outcome = await integrationTick({ ...dependencies, integrationId: integration.id })

    expect(outcome).toMatchObject({ outcome: 'failed', consecutiveFailures: 1 })
    const [run] = await fixtures.db().select().from(integrationRuns)
    expect(run.error).toContain('board unreachable')
    expect(run.endedAt).not.toBeNull()
  })

  it('leaves no open run behind after a failure, so the next tick is not blocked forever', async () => {
    const integration = await fixtures.seedIntegration()
    const { dependencies } = dependenciesWith([], { discoverError: new Error('board unreachable') })

    await integrationTick({ ...dependencies, integrationId: integration.id })
    const second = await integrationTick({ ...dependencies, integrationId: integration.id })

    expect(second.outcome).toBe('failed')
  })

  it('auto-disables after enough consecutive failures (FR-106)', async () => {
    const integration = await fixtures.seedIntegration({
      consecutiveFailures: DEFAULT_FAILURE_THRESHOLD - 1,
    })
    const { dependencies } = dependenciesWith([], { discoverError: new Error('board unreachable') })

    const outcome = await integrationTick({ ...dependencies, integrationId: integration.id })

    expect(outcome).toMatchObject({ outcome: 'failed', autoDisabled: true })
    expect((await fixtures.readIntegration(integration.id))?.enabled).toBe(false)
  })

  it('fails the tick rather than widening the query when no connector is registered (FR-192)', async () => {
    const integration = await fixtures.seedIntegration()
    const { dependencies } = dependenciesWith([])

    const outcome = await integrationTick({
      ...dependencies,
      connectors: createConnectorRegistry(),
      integrationId: integration.id,
    })

    expect(outcome).toMatchObject({ outcome: 'failed' })
    if (outcome.outcome !== 'failed') throw new Error('unreachable')
    expect(outcome.error).toContain('No connector is registered')
  })

  it('keeps the run when the pickup comment fails, and records the failure', async () => {
    const integration = await fixtures.seedIntegration()
    await fixtures.seedMapping({ integrationId: integration.id })
    const { dependencies } = dependenciesWith([fakeCandidate()], {
      writeBackError: new Error('the board rejected the comment'),
    })

    const outcome = await integrationTick({ ...dependencies, integrationId: integration.id })
    if (outcome.outcome !== 'completed') throw new Error('the tick did not complete')

    expect(await fixtures.countWorkflows()).toBe(1)
    expect(outcome.skips[0].reason).toBe('write_back_failed')
  })

  it('reports through the uniform job envelope', async () => {
    const integration = await fixtures.seedIntegration()
    await fixtures.seedMapping({ integrationId: integration.id })
    const { dependencies } = dependenciesWith([fakeCandidate()])

    const envelope = await runIntegrationTick({ ...dependencies, integrationId: integration.id })

    expect(envelope.ok).toBe(true)
    expect(envelope.jobName).toBe('integration-tick')
  })
})

/**
 * FR-102 is not a rule about a number; it is a rule about an **interleaving**. A sequential test
 * passes against a read-then-write claim that two concurrent ticks would both win, so these two
 * actually overlap, and the third resumes from a claim written without its workflow — which is what
 * a process killed mid-tick leaves behind.
 *
 * Remove `onConflictDoNothing` from `claimAndStart` and the first of these fails with a unique
 * violation instead of a second workflow; remove the single transaction and the third one fails
 * with a claim whose run does not exist.
 */
describeWithDatabase('exactly-once claiming (FR-102, R8)', () => {
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

  const tickFor = (integrationId: string) =>
    integrationTick({
      db: fixtures.db(),
      connectors: createConnectorRegistry({
        jira: fakeConnectorFactory(
          createFakeConnector({ items: [fakeCandidate({ externalId: 'FIX-7' })] }),
        ),
      }),
      readCredential,
      redactor,
      integrationId,
    })

  /** The run record the FR-103 guard reads, as a process that died mid-tick would leave it: gone. */
  const forgetOpenRuns = async (integrationId: string): Promise<void> => {
    await fixtures
      .db()
      .delete(integrationRuns)
      .where(eq(integrationRuns.integrationId, integrationId))
  }

  it('two ticks fired together produce exactly one workflow', async () => {
    const integration = await fixtures.seedIntegration()
    await fixtures.seedMapping({ integrationId: integration.id })

    // Two guards stand between these and a duplicate, and which one fires depends on the
    // interleaving: the FR-103 open-run check, or `ticket_claims`' unique index. The assertion is
    // deliberately about the outcome rather than about which one won, because a tick that relied on
    // a particular one would be a tick that broke when the timing changed. The index is raced
    // directly, without the run-record guard in the way, in `integration-store.test.ts`.
    const outcomes = await Promise.all([tickFor(integration.id), tickFor(integration.id)])

    expect(await fixtures.countWorkflows()).toBe(1)
    expect(await fixtures.countClaims()).toBe(1)
    expect(outcomes.every((outcome) => outcome.outcome !== 'failed')).toBe(true)
  })

  it('four ticks fired together still produce exactly one workflow', async () => {
    const integration = await fixtures.seedIntegration()
    await fixtures.seedMapping({ integrationId: integration.id })

    await Promise.all([
      tickFor(integration.id),
      tickFor(integration.id),
      tickFor(integration.id),
      tickFor(integration.id),
    ])

    expect(await fixtures.countWorkflows()).toBe(1)
    expect(await fixtures.countClaims()).toBe(1)
  })

  it('a restart mid-tick produces exactly one workflow, not a second one', async () => {
    const integration = await fixtures.seedIntegration()
    await fixtures.seedMapping({ integrationId: integration.id })

    await tickFor(integration.id)
    // The restart: the run record is gone (the process died before closing it), so the next
    // invocation genuinely re-runs the same tick from the top against the same board state.
    await forgetOpenRuns(integration.id)

    const outcome = await tickFor(integration.id)
    if (outcome.outcome !== 'completed') throw new Error('the tick did not complete')

    expect(await fixtures.countWorkflows()).toBe(1)
    expect(outcome.started).toBe(0)
    expect(outcome.skips[0].reason).toBe('already_claimed')
  })

  it('posts no second comment for a ticket it has already claimed (FR-143)', async () => {
    const integration = await fixtures.seedIntegration()
    await fixtures.seedMapping({ integrationId: integration.id })

    const connector = createFakeConnector({ items: [fakeCandidate({ externalId: 'FIX-7' })] })
    const dependencies = {
      db: fixtures.db(),
      connectors: createConnectorRegistry({ jira: fakeConnectorFactory(connector) }),
      readCredential,
      redactor,
    }

    await integrationTick({ ...dependencies, integrationId: integration.id })
    await forgetOpenRuns(integration.id)
    await integrationTick({ ...dependencies, integrationId: integration.id })

    expect(connector.writeBacks).toHaveLength(1)
  })

  it('never leaves a claim without the run it was taken for', async () => {
    const integration = await fixtures.seedIntegration()
    await fixtures.seedMapping({ integrationId: integration.id })

    await tickFor(integration.id)

    const [claim] = await fixtures
      .db()
      .select({ workflowId: ticketClaims.workflowId })
      .from(ticketClaims)
      .orderBy(desc(ticketClaims.claimedAt))

    expect(claim.workflowId).not.toBeNull()
  })

  it('starts one workflow when two integrations point at the same board (FR-104)', async () => {
    const first = await fixtures.seedIntegration({ name: `board-a-${fixtures.suffix}` })
    const second = await fixtures.seedIntegration({ name: `board-b-${fixtures.suffix}` })
    await fixtures.seedMapping({ integrationId: first.id })
    await fixtures.seedMapping({ integrationId: second.id })

    await tickFor(first.id)
    const loser = await tickFor(second.id)
    if (loser.outcome !== 'completed') throw new Error('the tick did not complete')

    expect(await fixtures.countWorkflows()).toBe(1)
    expect(loser.skips[0].reason).toBe('claimed_by_another_integration')
    expect(loser.skips[0].detail).toContain(first.id)
  })

  it('lets two integrations on different boards each start their own FIX-7', async () => {
    const first = await fixtures.seedIntegration({
      name: `board-a-${fixtures.suffix}`,
      baseUrl: 'https://one.invalid',
    })
    const second = await fixtures.seedIntegration({
      name: `board-b-${fixtures.suffix}`,
      baseUrl: 'https://two.invalid',
    })
    await fixtures.seedMapping({ integrationId: first.id })
    await fixtures.seedMapping({ integrationId: second.id })

    await tickFor(first.id)
    await tickFor(second.id)

    // `FIX-7` on one client's board and `FIX-7` on another's are different tickets; a globally
    // unique external id would put the second one permanently out of reach.
    expect(await fixtures.countWorkflowsFor(first.id)).toBe(1)
    expect(await fixtures.countWorkflowsFor(second.id)).toBe(1)
  })
})
