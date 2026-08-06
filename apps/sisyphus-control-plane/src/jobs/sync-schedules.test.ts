import { integrations } from '@bluetel-ai/sisyphus-api/db'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createFakeScheduleRegistry } from '../aws'

import { createIntegrationFixtures, readTestDatabaseUrl } from './integration-fixtures'
import {
  integrationIdFromScheduleName,
  removeSchedule,
  runSyncSchedules,
  SCHEDULE_NAME_PREFIX,
  scheduleNameFor,
  schedulePayloadFor,
  syncSchedules,
  toSchedulerExpression,
} from './sync-schedules'

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

describe('schedule naming', () => {
  it('derives the name from the id, so a rename cannot orphan a schedule', () => {
    expect(scheduleNameFor('abc')).toBe(`${SCHEDULE_NAME_PREFIX}abc`)
  })

  it('round-trips the id out of the name', () => {
    expect(integrationIdFromScheduleName(scheduleNameFor('abc'))).toBe('abc')
  })

  it('does not claim a name this platform did not create, so a sweep cannot delete it', () => {
    expect(integrationIdFromScheduleName('someone-elses-nightly-report')).toBeUndefined()
  })

  it('names the integration and the trigger in the payload', () => {
    expect(JSON.parse(schedulePayloadFor('abc'))).toEqual({
      job: 'integration-tick',
      integrationId: 'abc',
      trigger: 'scheduled',
    })
  })
})

describe('toSchedulerExpression (FR-154)', () => {
  it('accepts the five-field cron an admin actually writes', () => {
    expect(toSchedulerExpression('0/15 * * * *')).toBe('cron(0/15 * * * ? *)')
  })

  it('turns a day-of-week schedule into the ? convention on day-of-month', () => {
    expect(toSchedulerExpression('0 9 * * MON-FRI')).toBe('cron(0 9 ? * MON-FRI *)')
  })

  it('keeps a day-of-month schedule as written', () => {
    expect(toSchedulerExpression('0 9 1 * *')).toBe('cron(0 9 1 * ? *)')
  })

  it('passes a rate expression through untouched', () => {
    expect(toSchedulerExpression('rate(15 minutes)')).toBe('rate(15 minutes)')
  })

  it('passes an already-wrapped six-field cron through untouched', () => {
    expect(toSchedulerExpression('cron(0 9 ? * MON *)')).toBe('cron(0 9 ? * MON *)')
  })

  it('wraps a bare six-field expression rather than rejecting it', () => {
    expect(toSchedulerExpression('0 9 ? * MON *')).toBe('cron(0 9 ? * MON *)')
  })

  it('refuses an expression constraining both day fields rather than reinterpreting it', () => {
    expect(() => toSchedulerExpression('0 9 1 * MON')).toThrow(/both day-of-month and day-of-week/)
  })

  it('refuses an expression it cannot parse rather than registering a guess', () => {
    expect(() => toSchedulerExpression('every fifteen minutes')).toThrow(/expected five-field cron/)
  })
})

describeWithDatabase('syncSchedules against a live database (T118, FR-100, FR-155)', () => {
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

  it('registers an enabled integration in its own timezone (FR-155)', async () => {
    const schedules = createFakeScheduleRegistry()
    const integration = await fixtures.seedIntegration({
      timezone: 'Australia/Sydney',
      cronExpression: '0 9 * * *',
    })

    await syncSchedules({ db: fixtures.db(), schedules })

    const definition = schedules.current(scheduleNameFor(integration.id))

    expect(definition?.timezone).toBe('Australia/Sydney')
    expect(definition?.expression).toBe('cron(0 9 * * ? *)')
    expect(definition?.enabled).toBe(true)
  })

  it('never converts the expression to UTC, so a wall-clock schedule stays at its wall clock', async () => {
    const schedules = createFakeScheduleRegistry()
    const integration = await fixtures.seedIntegration({
      timezone: 'Europe/London',
      cronExpression: '30 8 * * *',
    })

    await syncSchedules({ db: fixtures.db(), schedules })

    // 08:30 London is 07:30 UTC in winter and 08:30 UTC in summer. The expression is unchanged in
    // both, which is what makes daylight saving a non-event for the board.
    expect(schedules.current(scheduleNameFor(integration.id))?.expression).toBe(
      'cron(30 8 * * ? *)',
    )
  })

  it('records that the integration has a schedule', async () => {
    const schedules = createFakeScheduleRegistry()
    const integration = await fixtures.seedIntegration()

    await syncSchedules({ db: fixtures.db(), schedules })

    expect((await fixtures.readIntegration(integration.id))?.scheduleArn).toBe(
      scheduleNameFor(integration.id),
    )
  })

  it('re-registers when the cron expression changes (FR-100)', async () => {
    const schedules = createFakeScheduleRegistry()
    const integration = await fixtures.seedIntegration({ cronExpression: '0/15 * * * *' })

    await syncSchedules({ db: fixtures.db(), schedules })

    await fixtures
      .db()
      .update(integrations)
      .set({ cronExpression: '0 * * * *' })
      .where(eq(integrations.id, integration.id))

    await syncSchedules({ db: fixtures.db(), schedules })

    expect(schedules.upserts.map((upsert) => upsert.expression)).toEqual([
      'cron(0/15 * * * ? *)',
      'cron(0 * * * ? *)',
    ])
  })

  it('brings a schedule to disabled when the integration is disabled (FR-100)', async () => {
    const schedules = createFakeScheduleRegistry()
    const integration = await fixtures.seedIntegration({ enabled: true })

    await syncSchedules({ db: fixtures.db(), schedules })
    expect(schedules.current(scheduleNameFor(integration.id))?.enabled).toBe(true)

    await fixtures
      .db()
      .update(integrations)
      .set({ enabled: false })
      .where(eq(integrations.id, integration.id))

    await syncSchedules({ db: fixtures.db(), schedules })

    // The failure this catches is the loud one: a disabled integration whose schedule keeps firing
    // goes on starting paid runs.
    expect(schedules.current(scheduleNameFor(integration.id))?.enabled).toBe(false)
  })

  it('keeps a disabled integration schedule rather than deleting it', async () => {
    const schedules = createFakeScheduleRegistry()
    const integration = await fixtures.seedIntegration({ enabled: false })

    await syncSchedules({ db: fixtures.db(), schedules })

    expect(schedules.removals).toEqual([])
    expect(await schedules.list()).toEqual([scheduleNameFor(integration.id)])
  })

  it('is idempotent: running it twice leaves the same group', async () => {
    const schedules = createFakeScheduleRegistry()
    await fixtures.seedIntegration()

    const first = await syncSchedules({ db: fixtures.db(), schedules })
    const before = await schedules.list()
    const second = await syncSchedules({ db: fixtures.db(), schedules })

    expect(second.actions).toEqual(first.actions)
    expect(await schedules.list()).toEqual(before)
  })

  it('sweeps the schedule of an integration that no longer exists', async () => {
    const schedules = createFakeScheduleRegistry()
    await schedules.upsert({
      name: scheduleNameFor('11111111-1111-4111-8111-111111111111'),
      expression: 'rate(15 minutes)',
      timezone: 'UTC',
      payload: '{}',
    })

    const result = await syncSchedules({ db: fixtures.db(), schedules })

    expect(result.swept).toEqual([scheduleNameFor('11111111-1111-4111-8111-111111111111')])
    expect(await schedules.list()).toEqual([])
  })

  it('leaves a schedule this platform did not create alone', async () => {
    const schedules = createFakeScheduleRegistry()
    await schedules.upsert({
      name: 'nightly-report',
      expression: 'rate(1 day)',
      timezone: 'UTC',
      payload: '{}',
    })

    const result = await syncSchedules({ db: fixtures.db(), schedules })

    expect(result.swept).toEqual([])
    expect(await schedules.list()).toEqual(['nightly-report'])
  })

  it('records a failing row rather than abandoning the sweep', async () => {
    const schedules = createFakeScheduleRegistry()
    await fixtures.seedIntegration({ cronExpression: 'every fifteen minutes' })
    await fixtures.seedIntegration({ cronExpression: '0/15 * * * *' })

    const result = await syncSchedules({ db: fixtures.db(), schedules })

    expect(result.failures).toBe(1)
    expect(result.actions.filter((action) => action.action === 'registered')).toHaveLength(1)
  })

  it('removes one integration schedule on demand, and again without complaint', async () => {
    const schedules = createFakeScheduleRegistry()
    const integration = await fixtures.seedIntegration()

    await syncSchedules({ db: fixtures.db(), schedules })
    await removeSchedule(schedules, integration.id)
    await removeSchedule(schedules, integration.id)

    expect(await schedules.list()).toEqual([])
  })

  it('reports through the uniform job envelope', async () => {
    const schedules = createFakeScheduleRegistry()
    await fixtures.seedIntegration()

    const outcome = await runSyncSchedules({ db: fixtures.db(), schedules })

    expect(outcome.ok).toBe(true)
    expect(outcome.jobName).toBe('sync-schedules')
  })
})
