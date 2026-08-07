import { describe, expect, it } from 'vitest'

import type { IntegrationRunView } from './integrations-client'
import { formatCounts, formatDuration, looksSilentlyStalled, toRunHistory } from './run-history'

const run = (overrides: Partial<IntegrationRunView> = {}): IntegrationRunView => ({
  id: 'run-1',
  trigger: 'scheduled',
  startedAt: new Date('2026-03-01T09:00:00.000Z'),
  endedAt: new Date('2026-03-01T09:00:12.000Z'),
  examinedCount: 12,
  matchedCount: 4,
  startedCount: 3,
  skippedCount: 1,
  error: null,
  ...overrides,
})

describe('toRunHistory (FR-105)', () => {
  it('renders a tick as what it did, not as a status', () => {
    expect(toRunHistory([run()])).toStrictEqual([
      {
        id: 'run-1',
        trigger: 'scheduled',
        startedAt: '2026-03-01 09:00:00',
        duration: '12s',
        counts: 'examined 12, matched 4, started 3, skipped 1',
        error: undefined,
        failed: false,
      },
    ])
  })

  it('marks a failed tick and carries its reason (FR-108)', () => {
    expect(toRunHistory([run({ error: 'the credential was rejected' })])).toMatchObject([
      { failed: true, error: 'the credential was rejected' },
    ])
  })

  it('distinguishes a manual tick from a scheduled one', () => {
    expect(toRunHistory([run({ trigger: 'manual' })])).toMatchObject([{ trigger: 'manual' }])
  })

  it('keeps the order it was given, which is newest first from the router', () => {
    const rows = toRunHistory([run({ id: 'newest' }), run({ id: 'older' })])

    expect(rows.map((row) => row.id)).toStrictEqual(['newest', 'older'])
  })

  it('is empty for a board that has never ticked', () => {
    expect(toRunHistory([])).toStrictEqual([])
  })
})

describe('formatCounts', () => {
  it('prints all four counts including the zeroes, which are the observation', () => {
    expect(
      formatCounts(run({ examinedCount: 40, matchedCount: 40, startedCount: 0, skippedCount: 0 })),
    ).toBe('examined 40, matched 40, started 0, skipped 0')
  })
})

describe('formatDuration', () => {
  it('reports seconds under a minute', () => {
    expect(formatDuration(run())).toBe('12s')
  })

  it('reports minutes and seconds beyond one', () => {
    expect(
      formatDuration(
        run({
          startedAt: new Date('2026-03-01T09:00:00.000Z'),
          endedAt: new Date('2026-03-01T09:02:05.000Z'),
        }),
      ),
    ).toBe('2m 5s')
  })

  it('says a run has not finished rather than measuring it against the current clock', () => {
    expect(formatDuration(run({ endedAt: null }))).toBe('still running')
  })
})

describe('looksSilentlyStalled (FR-105)', () => {
  const stalled = run({ matchedCount: 4, startedCount: 0, error: null })

  it('spots three consecutive ticks that matched work and started none of it', () => {
    expect(looksSilentlyStalled([stalled, stalled, stalled])).toBe(true)
  })

  it('is the case FR-106 misses: those ticks succeeded, so nothing auto-disables', () => {
    expect([stalled, stalled, stalled].every((tick) => tick.error === null)).toBe(true)
    expect(looksSilentlyStalled([stalled, stalled, stalled])).toBe(true)
  })

  it('is not raised while a tick is still starting work', () => {
    expect(looksSilentlyStalled([run(), stalled, stalled])).toBe(false)
  })

  it('is not raised for a board with nothing to match — that is idle, not stalled', () => {
    const idle = run({ matchedCount: 0, startedCount: 0 })

    expect(looksSilentlyStalled([idle, idle, idle])).toBe(false)
  })

  it('is not raised for failing ticks, which FR-106 already counts and acts on', () => {
    const failing = run({ matchedCount: 4, startedCount: 0, error: 'unreachable' })

    expect(looksSilentlyStalled([failing, failing, failing])).toBe(false)
  })

  it('needs three ticks before it will say anything', () => {
    expect(looksSilentlyStalled([stalled, stalled])).toBe(false)
    expect(looksSilentlyStalled([])).toBe(false)
  })
})
