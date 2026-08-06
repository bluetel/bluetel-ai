import { describe, expect, it } from 'vitest'

import { createFakeScheduleRegistry } from './schedules-fake'

const definition = {
  name: 'integration-1',
  expression: 'cron(0/5 * * * ? *)',
  timezone: 'Europe/London',
  payload: '{}',
}

describe('the fake schedule registry', () => {
  it('records every upsert and keeps the last one as current', async () => {
    const schedules = createFakeScheduleRegistry()

    await schedules.upsert(definition)
    await schedules.upsert({ ...definition, expression: 'cron(0 9 * * ? *)' })

    expect(schedules.upserts.map((upsert) => upsert.expression)).toEqual([
      'cron(0/5 * * * ? *)',
      'cron(0 9 * * ? *)',
    ])
    expect(schedules.current('integration-1')?.expression).toBe('cron(0 9 * * ? *)')
  })

  it('lists names sorted and drops a removed one', async () => {
    const schedules = createFakeScheduleRegistry()
    await schedules.upsert({ ...definition, name: 'integration-2' })
    await schedules.upsert(definition)

    await expect(schedules.list()).resolves.toEqual(['integration-1', 'integration-2'])

    await schedules.remove({ name: 'integration-1' })

    expect(schedules.removals).toEqual(['integration-1'])
    await expect(schedules.list()).resolves.toEqual(['integration-2'])
    expect(schedules.current('integration-1')).toBeUndefined()
  })

  it('tolerates removing a schedule it never had', async () => {
    const schedules = createFakeScheduleRegistry()

    await expect(schedules.remove({ name: 'never' })).resolves.toBeUndefined()
    expect(schedules.removals).toEqual(['never'])
  })
})
