import { describe, expect, it } from 'vitest'

import { parseCron } from './cron-schedule'
import {
  CUSTOM_SCHEDULE_ID,
  expressionForPreset,
  isKnownTimezone,
  NEXT_RUN_COUNT,
  presetForExpression,
  SCHEDULE_PRESETS,
  scheduleReadback,
  timezoneOptions,
} from './schedule-presets'

const at = (iso: string): Date => new Date(iso)

describe('the presets (FR-154)', () => {
  it.each(SCHEDULE_PRESETS)('$label is a readable expression', (preset) => {
    expect(parseCron(preset.expression)).toBeDefined()
  })

  it('has unique ids and unique expressions, so a round trip is unambiguous', () => {
    expect(new Set(SCHEDULE_PRESETS.map((preset) => preset.id)).size).toBe(SCHEDULE_PRESETS.length)
    expect(new Set(SCHEDULE_PRESETS.map((preset) => preset.expression)).size).toBe(
      SCHEDULE_PRESETS.length,
    )
  })

  it('anchors hourly to minute zero rather than to when it was saved', () => {
    expect(expressionForPreset('hourly')).toBe('0 * * * *')
  })

  it('round-trips an expression back to the preset it came from', () => {
    for (const preset of SCHEDULE_PRESETS) {
      expect(presetForExpression(preset.expression)).toBe(preset.id)
    }
  })

  it('reports a hand-written expression as custom rather than as the nearest preset', () => {
    expect(presetForExpression('7 3 * * 2')).toBe(CUSTOM_SCHEDULE_ID)
  })

  it('reports an unknown preset id as having no expression', () => {
    expect(expressionForPreset('every-fortnight')).toBeUndefined()
  })
})

describe('scheduleReadback (FR-154, FR-155)', () => {
  it('gives the plain-language description and five fire times', () => {
    const readback = scheduleReadback('0/15 * * * *', 'UTC', at('2026-08-05T10:00:00Z'))

    expect(readback.readable).toBe(true)
    expect(readback.nextRuns).toHaveLength(NEXT_RUN_COUNT)
    expect(readback.description).toContain('minute 15')
  })

  it('renders the fire times in the integration timezone, and says which one', () => {
    const readback = scheduleReadback('0 9 * * *', 'Australia/Sydney', at('2026-08-05T00:00:00Z'))

    expect(readback.timezone).toBe('Australia/Sydney')
    expect(readback.nextRuns[0]).toBe('2026-08-06 09:00')
  })

  it('is unreadable — and offers no fire times — for an expression it cannot parse', () => {
    const readback = scheduleReadback('every fifteen minutes', 'UTC', at('2026-08-05T10:00:00Z'))

    expect(readback.readable).toBe(false)
    expect(readback.nextRuns).toEqual([])
    expect(readback.description).toContain('could not be read')
  })

  it('is unreadable for a timezone the platform cannot evaluate', () => {
    const readback = scheduleReadback('0 9 * * *', 'Mars/Olympus_Mons', at('2026-08-05T10:00:00Z'))

    expect(readback.readable).toBe(false)
    expect(readback.nextRuns).toEqual([])
  })
})

describe('isKnownTimezone', () => {
  it('accepts an IANA zone', () => {
    expect(isKnownTimezone('Europe/London')).toBe(true)
  })

  it('rejects one the platform cannot evaluate, rather than defaulting to UTC', () => {
    expect(isKnownTimezone('Mars/Olympus_Mons')).toBe(false)
  })
})

describe('timezoneOptions', () => {
  it('always includes the integration current zone, so editing cannot silently move it', () => {
    expect(timezoneOptions('Pacific/Auckland', 'Europe/London')).toContain('Pacific/Auckland')
  })

  it('puts the current zone first', () => {
    expect(timezoneOptions('Asia/Tokyo', 'Europe/London')[0]).toBe('Asia/Tokyo')
  })

  it('offers the reader own zone without repeating it', () => {
    const options = timezoneOptions('Europe/London', 'Europe/London')

    expect(options.filter((zone) => zone === 'Europe/London')).toHaveLength(1)
  })

  it('is a short list rather than the whole database', () => {
    expect(timezoneOptions('UTC', 'UTC').length).toBeLessThan(15)
  })
})
