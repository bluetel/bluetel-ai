import { describe, expect, it } from 'vitest'

import {
  describeCron,
  formatInZone,
  instantFromWallClock,
  nextFireTimes,
  parseCron,
  parseCronField,
  wallClockIn,
} from './cron-schedule'

/* cspell:ignore FUNDAY */

const at = (iso: string): Date => new Date(iso)

describe('parseCronField', () => {
  it('reads a wildcard as every value in range', () => {
    expect(parseCronField('*', 0, 3)?.size).toBe(4)
  })

  it('reads a list', () => {
    expect([...(parseCronField('0,15,30', 0, 59) ?? [])]).toEqual([0, 15, 30])
  })

  it('reads a range', () => {
    expect([...(parseCronField('1-4', 0, 59) ?? [])]).toEqual([1, 2, 3, 4])
  })

  it('reads a step over a wildcard', () => {
    expect([...(parseCronField('*/20', 0, 59) ?? [])]).toEqual([0, 20, 40])
  })

  it('reads a step from a starting value, as crontab means it', () => {
    expect([...(parseCronField('5/20', 0, 59) ?? [])]).toEqual([5, 25, 45])
  })

  it('reads three-letter names', () => {
    expect([
      ...(parseCronField('MON-FRI', 0, 6, ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']) ?? []),
    ]).toEqual([1, 2, 3, 4, 5])
  })

  it('refuses a value outside the field, rather than clamping it', () => {
    expect(parseCronField('99', 0, 59)).toBeUndefined()
  })

  it('refuses a reversed range', () => {
    expect(parseCronField('40-10', 0, 59)).toBeUndefined()
  })

  it('refuses a zero or absent step rather than widening the schedule', () => {
    expect(parseCronField('*/0', 0, 59)).toBeUndefined()
    expect(parseCronField('*/', 0, 59)).toBeUndefined()
  })

  it('refuses text it cannot read, so an unreadable field never becomes a wildcard', () => {
    expect(parseCronField('often', 0, 59)).toBeUndefined()
  })
})

describe('parseCron', () => {
  it('reads a five-field expression', () => {
    const fields = parseCron('0/15 * * * *')

    expect([...(fields?.minutes ?? [])]).toEqual([0, 15, 30, 45])
    expect(fields?.daysOfMonth).toBe('any')
    expect(fields?.daysOfWeek).toBe('any')
  })

  it('treats ? like * on the day fields, so a Scheduler expression reads too', () => {
    expect(parseCron('0 9 ? * MON')?.daysOfMonth).toBe('any')
  })

  it('refuses anything that is not five fields', () => {
    expect(parseCron('0 9 * *')).toBeUndefined()
    expect(parseCron('0 9 * * * *')).toBeUndefined()
  })

  it('refuses an expression with an unreadable field', () => {
    expect(parseCron('0 9 * * FUNDAY')).toBeUndefined()
  })
})

describe('wall-clock conversion (FR-155)', () => {
  it('reads the zone clock rather than the runner clock', () => {
    expect(wallClockIn(at('2026-01-15T09:00:00Z'), 'Australia/Sydney')).toMatchObject({
      year: 2026,
      month: 1,
      day: 15,
      hour: 20,
    })
  })

  it('renders midnight as hour zero rather than as twenty-four', () => {
    expect(wallClockIn(at('2026-01-15T00:00:00Z'), 'UTC').hour).toBe(0)
  })

  it('round-trips a wall clock to the instant the zone reads it at', () => {
    const instant = instantFromWallClock(
      { year: 2026, month: 1, day: 15, hour: 9, minute: 0 },
      'Europe/London',
    )

    expect(instant?.toISOString()).toBe('2026-01-15T09:00:00.000Z')
  })

  it('solves the offset on the summer side of the transition too', () => {
    const instant = instantFromWallClock(
      { year: 2026, month: 7, day: 15, hour: 9, minute: 0 },
      'Europe/London',
    )

    // 09:00 London in July is 08:00 UTC. A single-pass offset solve gets this wrong.
    expect(instant?.toISOString()).toBe('2026-07-15T08:00:00.000Z')
  })

  it('reports a wall clock the zone skipped over as having no instant', () => {
    // 2026-03-29, London jumps 01:00 → 02:00. There is no 01:30.
    expect(
      instantFromWallClock({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 }, 'Europe/London'),
    ).toBeUndefined()
  })
})

describe('nextFireTimes (FR-154, FR-155)', () => {
  it('produces the number asked for', () => {
    expect(nextFireTimes('0/15 * * * *', 'UTC', 5, at('2026-08-05T10:00:00Z'))).toHaveLength(5)
  })

  it('produces them ascending and strictly after the moment given', () => {
    const times = nextFireTimes('0/15 * * * *', 'UTC', 4, at('2026-08-05T10:00:00Z'))

    expect(times.map((time) => time.toISOString())).toEqual([
      '2026-08-05T10:15:00.000Z',
      '2026-08-05T10:30:00.000Z',
      '2026-08-05T10:45:00.000Z',
      '2026-08-05T11:00:00.000Z',
    ])
  })

  it('evaluates a daily schedule in the integration timezone, not the runner timezone', () => {
    const times = nextFireTimes('0 9 * * *', 'Australia/Sydney', 1, at('2026-08-05T00:00:00Z'))

    // The moment given is 10:00 on the 5th in Sydney, so that day's 09:00 has gone: the next fire
    // is the 6th. In UTC that instant is on the 5th — which is exactly the confusion FR-155 is
    // about, and why the panel never renders a fire time in the reader's own zone.
    expect(formatInZone(times[0], 'Australia/Sydney')).toBe('2026-08-06 09:00')
    expect(times[0].toISOString()).toBe('2026-08-05T23:00:00.000Z')
  })

  it('keeps a wall-clock schedule at its wall clock across the spring transition (FR-155)', () => {
    const times = nextFireTimes('0 9 * * *', 'Europe/London', 3, at('2026-03-28T00:00:00Z'))

    // The UTC instant moves by an hour; the London clock does not.
    expect(times.map((time) => formatInZone(time, 'Europe/London'))).toEqual([
      '2026-03-28 09:00',
      '2026-03-29 09:00',
      '2026-03-30 09:00',
    ])
    expect(times[0].toISOString()).toBe('2026-03-28T09:00:00.000Z')
    expect(times[1].toISOString()).toBe('2026-03-29T08:00:00.000Z')
  })

  it('skips a wall clock the spring transition deleted rather than firing an hour late', () => {
    const times = nextFireTimes('30 1 * * *', 'Europe/London', 2, at('2026-03-28T12:00:00Z'))

    // There is no 01:30 on the 29th, so the next two are the 30th and the 31st.
    expect(times.map((time) => formatInZone(time, 'Europe/London'))).toEqual([
      '2026-03-30 01:30',
      '2026-03-31 01:30',
    ])
  })

  it('shows one fire time for a wall clock the autumn transition repeated', () => {
    const times = nextFireTimes('30 1 * * *', 'Europe/London', 1, at('2026-10-24T12:00:00Z'))

    expect(times).toHaveLength(1)
    expect(formatInZone(times[0], 'Europe/London')).toBe('2026-10-25 01:30')
  })

  it('honours a day-of-week constraint', () => {
    const times = nextFireTimes('0 9 * * MON-FRI', 'UTC', 3, at('2026-08-07T12:00:00Z'))

    // 7 August 2026 is a Friday, so the next three are Mon/Tue/Wed.
    expect(times.map((time) => formatInZone(time, 'UTC'))).toEqual([
      '2026-08-10 09:00',
      '2026-08-11 09:00',
      '2026-08-12 09:00',
    ])
  })

  it('honours a day-of-month constraint', () => {
    const times = nextFireTimes('0 9 1 * *', 'UTC', 2, at('2026-08-05T12:00:00Z'))

    expect(times.map((time) => formatInZone(time, 'UTC'))).toEqual([
      '2026-09-01 09:00',
      '2026-10-01 09:00',
    ])
  })

  it('produces nothing for an expression it cannot read, rather than a wrong list', () => {
    expect(nextFireTimes('every fifteen minutes', 'UTC', 5, at('2026-08-05T10:00:00Z'))).toEqual([])
  })

  it('produces nothing for a schedule that never fires within the search window', () => {
    expect(nextFireTimes('0 9 30 2 *', 'UTC', 1, at('2026-08-05T10:00:00Z'))).toEqual([])
  })
})

describe('formatInZone', () => {
  it('renders the board clock, never the browser clock (FR-155)', () => {
    expect(formatInZone(at('2026-08-05T09:00:00Z'), 'Australia/Sydney')).toBe('2026-08-05 19:00')
  })
})

describe('describeCron — the plain-language readback (FR-154)', () => {
  it('describes an interval', () => {
    expect(describeCron('0/15 * * * *')).toBe(
      'at minute 0, minute 15, minute 30 and minute 45 of every hour every day',
    )
  })

  it('describes a daily time', () => {
    expect(describeCron('0 9 * * *')).toBe('at 09:00 every day')
  })

  it('describes a weekday schedule by name', () => {
    expect(describeCron('0 9 * * MON-FRI')).toBe('at 09:00 on MON, TUE, WED, THU and FRI')
  })

  it('describes a day-of-month schedule', () => {
    expect(describeCron('0 9 1 * *')).toBe('at 09:00 on day 1 of the month')
  })

  it('describes every minute', () => {
    expect(describeCron('* * * * *')).toBe('every minute every day')
  })

  it('names the months when the schedule is seasonal', () => {
    expect(describeCron('0 9 * JAN *')).toContain('in JAN')
  })

  it('says an unreadable expression is unreadable rather than describing something else', () => {
    expect(describeCron('every fifteen minutes')).toContain('could not be read')
  })
})
