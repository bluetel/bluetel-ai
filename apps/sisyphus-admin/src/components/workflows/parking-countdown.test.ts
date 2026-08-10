import { describe, expect, it } from 'vitest'

import { PAUSE_IDLE_CEILING_MS, toParkingCountdownReadout } from './parking-countdown'
import type { TimelineItem } from './workflow-detail-readouts'

/**
 * 003/FR-047 in executable form: *the time remaining before a paused workflow parks MUST be visible
 * to its owner.*
 *
 * The tests that earn their place are the ones about the ways a countdown quietly lies. A run
 * paused, resumed and paused again must count from the **current** pause — taking the first
 * `paused` row would show a minute-old pause as overdue, and an owner who believed it would rush a
 * decision they had half an hour to make. A pause the timeline never recorded must produce no
 * countdown at all rather than one measured from a timestamp that means something else. And a
 * server render, which has no clock, must not announce an imminent park to somebody who has thirty
 * minutes.
 */

const at = (iso: string): Date => new Date(iso)

const entry = (options: {
  readonly id: string
  readonly event: string
  readonly createdAt: string
}): TimelineItem =>
  ({
    id: options.id,
    event: options.event,
    actorType: 'executor',
    actorUserId: null,
    actorDisplayName: null,
    detail: null,
    createdAt: at(options.createdAt),
  }) as TimelineItem

const PAUSED_AT = '2026-08-09T09:00:00.000Z'

const pausedTimeline: readonly TimelineItem[] = [
  entry({ id: 'e1', event: 'started', createdAt: '2026-08-09T08:40:00.000Z' }),
  entry({ id: 'e2', event: 'paused', createdAt: PAUSED_AT }),
]

/** `now`, expressed as the thing a reader of these tests actually cares about. */
const minutesAfterPause = (minutes: number): number => at(PAUSED_AT).getTime() + minutes * 60_000

describe('toParkingCountdownReadout', () => {
  it('says how long is left before the run parks, and how long it has been paused', () => {
    const readout = toParkingCountdownReadout({
      state: 'paused',
      timeline: pausedTimeline,
      now: minutesAfterPause(4.5),
    })

    expect(readout).toMatchObject({
      headline: 'Parks if nobody resumes it',
      remaining: '25:30',
      pausedFor: '4:30',
      overdue: false,
    })
    // The three facts that make the countdown actionable rather than ominous: what parking
    // releases, what survives it, and that resuming now avoids the rebuild.
    expect(readout?.explanation).toContain('instance and disk are released')
    expect(readout?.explanation).toContain('snapshot')
    expect(readout?.explanation).toContain('same agent credential')
  })

  it('counts from the current pause, not the first one', () => {
    // A run paused, resumed and paused again. Counting from the first `paused` row would report
    // this one-minute-old pause as long overdue.
    const readout = toParkingCountdownReadout({
      state: 'paused',
      timeline: [
        entry({ id: 'e1', event: 'paused', createdAt: '2026-08-09T08:00:00.000Z' }),
        entry({ id: 'e2', event: 'resumed', createdAt: '2026-08-09T08:30:00.000Z' }),
        entry({ id: 'e3', event: 'paused', createdAt: PAUSED_AT }),
      ],
      now: minutesAfterPause(1),
    })

    expect(readout).toMatchObject({ remaining: '29:00', overdue: false })
  })

  it('says the park is due once the limit has passed', () => {
    const readout = toParkingCountdownReadout({
      state: 'paused',
      timeline: pausedTimeline,
      now: minutesAfterPause(31),
    })

    expect(readout).toMatchObject({ headline: 'Parking now', remaining: '0:00', overdue: true })
    // Past the limit the copy stops offering a remedy that no longer exists — the working tree is
    // going — and says what survives instead, because "parked" must not read as "failed".
    expect(readout?.explanation).toContain('Nothing is lost')
  })

  it('honours a ceiling the caller states rather than only its own copy', () => {
    // The constant here is a third copy of a number the executor and the control plane also hold.
    // Taking it as a parameter is what lets a caller that learns the real one pass it through.
    const readout = toParkingCountdownReadout({
      state: 'paused',
      timeline: pausedTimeline,
      now: minutesAfterPause(5),
      ceilingMs: 10 * 60_000,
    })

    expect(readout).toMatchObject({ remaining: '5:00', overdue: false })
    expect(readout?.explanation).toContain('10 minutes')
  })

  it('reads as the full ceiling before the browser has a clock', () => {
    // A server render has no `now`. Erring toward the full ceiling is the safe direction: the other
    // error flashes "parking now" at somebody who has half an hour.
    const readout = toParkingCountdownReadout({
      state: 'paused',
      timeline: pausedTimeline,
      now: undefined,
    })

    expect(readout).toMatchObject({ remaining: '30:00', overdue: false })
    expect(PAUSE_IDLE_CEILING_MS).toBe(30 * 60_000)
  })

  it('says nothing about a pause the timeline never recorded', () => {
    // The control plane leaves such a run alone for exactly this reason: there is no evidence of
    // when the pause began, so there is no deadline to put on screen.
    expect(
      toParkingCountdownReadout({
        state: 'paused',
        timeline: [entry({ id: 'e1', event: 'started', createdAt: PAUSED_AT })],
        now: minutesAfterPause(10),
      }),
    ).toBeUndefined()
  })

  it.each(['running' as const, 'parked_resumable' as const, 'succeeded' as const])(
    'says nothing for a run in state %s',
    (state) => {
      // Only a paused run is counting down. A parked one has already arrived, and its state chip
      // and outcome reason say so — a countdown beside them would be a third account of the same
      // moment, disagreeing with both.
      expect(
        toParkingCountdownReadout({
          state,
          timeline: pausedTimeline,
          now: minutesAfterPause(10),
        }),
      ).toBeUndefined()
    },
  )
})
