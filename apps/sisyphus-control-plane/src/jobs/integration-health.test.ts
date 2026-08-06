import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createIntegrationFixtures, readTestDatabaseUrl } from './integration-fixtures'
import {
  AUTO_DISABLED_PREFIX,
  autoDisabledReason,
  DEFAULT_FAILURE_THRESHOLD,
  recordRunOutcome,
  wasAutoDisabled,
} from './integration-health'

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

describe('the auto-disable reason', () => {
  it('says how many failures and why, so the panel can explain itself', () => {
    expect(autoDisabledReason(5, 'the board could not be reached')).toBe(
      'auto-disabled after 5 consecutive failed ticks: the board could not be reached',
    )
  })

  it('is distinguishable from an admin turning an integration off', () => {
    expect(wasAutoDisabled({ autoDisabledReason: autoDisabledReason(5, 'timeout') })).toBe(true)
    expect(wasAutoDisabled({ autoDisabledReason: null })).toBe(false)
    expect(wasAutoDisabled({ autoDisabledReason: 'switched off during the migration' })).toBe(false)
  })

  it('carries a prefix rather than requiring the panel to parse a sentence', () => {
    expect(autoDisabledReason(1, 'x').startsWith(AUTO_DISABLED_PREFIX)).toBe(true)
  })
})

describeWithDatabase('recordRunOutcome (T120, FR-106, FR-108)', () => {
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

  it('counts a failed tick', async () => {
    const integration = await fixtures.seedIntegration()

    const health = await recordRunOutcome(fixtures.db(), {
      integrationId: integration.id,
      succeeded: false,
      reason: 'the board could not be reached',
    })

    expect(health.consecutiveFailures).toBe(1)
    expect(health.autoDisabled).toBe(false)
    expect(health.enabled).toBe(true)
  })

  it('resets the count on any success — consecutive, not cumulative', async () => {
    const integration = await fixtures.seedIntegration({ consecutiveFailures: 3 })

    const health = await recordRunOutcome(fixtures.db(), {
      integrationId: integration.id,
      succeeded: true,
    })

    expect(health.consecutiveFailures).toBe(0)
    expect((await fixtures.readIntegration(integration.id))?.consecutiveFailures).toBe(0)
  })

  it('clears the reason on success, so the panel stops explaining a fault that is over', async () => {
    const integration = await fixtures.seedIntegration({
      consecutiveFailures: DEFAULT_FAILURE_THRESHOLD - 1,
    })

    await recordRunOutcome(fixtures.db(), { integrationId: integration.id, succeeded: false })
    await recordRunOutcome(fixtures.db(), { integrationId: integration.id, succeeded: true })

    expect((await fixtures.readIntegration(integration.id))?.autoDisabledReason).toBeNull()
  })

  it('auto-disables on the tick that reaches the threshold (FR-106)', async () => {
    const integration = await fixtures.seedIntegration({
      consecutiveFailures: DEFAULT_FAILURE_THRESHOLD - 1,
    })

    const health = await recordRunOutcome(fixtures.db(), {
      integrationId: integration.id,
      succeeded: false,
      reason: 'the board could not be reached',
    })

    expect(health.autoDisabled).toBe(true)
    expect(health.enabled).toBe(false)

    const row = await fixtures.readIntegration(integration.id)
    expect(row?.enabled).toBe(false)
    expect(row?.autoDisabledReason).toContain('the board could not be reached')
  })

  it('does not disable before the threshold', async () => {
    const integration = await fixtures.seedIntegration({
      consecutiveFailures: DEFAULT_FAILURE_THRESHOLD - 2,
    })

    const health = await recordRunOutcome(fixtures.db(), {
      integrationId: integration.id,
      succeeded: false,
    })

    expect(health.autoDisabled).toBe(false)
    expect((await fixtures.readIntegration(integration.id))?.enabled).toBe(true)
  })

  it('reports autoDisabled once, not on every later failure', async () => {
    const integration = await fixtures.seedIntegration({ perTickCeiling: 1 })

    const outcomes: boolean[] = []
    for (let attempt = 0; attempt < DEFAULT_FAILURE_THRESHOLD + 2; attempt += 1) {
      outcomes.push(
        (await recordRunOutcome(fixtures.db(), { integrationId: integration.id, succeeded: false }))
          .autoDisabled,
      )
    }

    expect(outcomes.filter(Boolean)).toHaveLength(1)
    expect(outcomes[DEFAULT_FAILURE_THRESHOLD - 1]).toBe(true)
  })

  it('never re-enables itself — that is a human act', async () => {
    const integration = await fixtures.seedIntegration({
      consecutiveFailures: DEFAULT_FAILURE_THRESHOLD - 1,
    })

    await recordRunOutcome(fixtures.db(), { integrationId: integration.id, succeeded: false })
    await recordRunOutcome(fixtures.db(), { integrationId: integration.id, succeeded: true })

    expect((await fixtures.readIntegration(integration.id))?.enabled).toBe(false)
  })

  it('leaves the schedule marker alone, so only one module owns the schedule', async () => {
    const integration = await fixtures.seedIntegration({
      consecutiveFailures: DEFAULT_FAILURE_THRESHOLD - 1,
    })

    await recordRunOutcome(fixtures.db(), { integrationId: integration.id, succeeded: false })

    expect((await fixtures.readIntegration(integration.id))?.scheduleArn).toBe(
      integration.scheduleArn,
    )
  })

  it('honours a caller-supplied threshold', async () => {
    const integration = await fixtures.seedIntegration()

    const health = await recordRunOutcome(fixtures.db(), {
      integrationId: integration.id,
      succeeded: false,
      threshold: 1,
    })

    expect(health.autoDisabled).toBe(true)
  })

  it('refuses to record against an integration that has gone', async () => {
    await expect(
      recordRunOutcome(fixtures.db(), {
        integrationId: '11111111-1111-4111-8111-111111111111',
        succeeded: false,
      }),
    ).rejects.toThrow(/does not exist/)
  })
})
