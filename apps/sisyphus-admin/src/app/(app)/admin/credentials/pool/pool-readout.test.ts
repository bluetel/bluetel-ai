import { describe, expect, it } from 'vitest'

import type { PoolGroup, PoolSeat, PoolView } from './pool-readout'
import {
  describeHolders,
  formatDuration,
  NO_DURATION,
  toPoolGroupReadout,
  toPoolSeatReadout,
  toPoolSummary,
} from './pool-readout'

/**
 * The shaping behind the pool page (T113, SC-011, FR-074).
 *
 * The one thing on this screen that can be **wrong** rather than merely ugly is the sentence at the
 * top of it, so that is what is asserted hardest: an under-sized group and an under-sized pool are
 * different purchases, and a banner that named the wrong one would send somebody to buy capacity
 * that cannot serve the runs that are waiting.
 */

const now = new Date('2026-03-01T12:00:00.000Z')

const seat = (overrides: Partial<PoolSeat> = {}): PoolSeat => ({
  id: 'seat-1',
  name: 'vendor-seat-1',
  state: 'available',
  health: 'healthy',
  enabled: true,
  selectable: true,
  holder: null,
  lastUsedAt: null,
  lastExercisedAt: null,
  lastLoginAt: null,
  coolingOffUntil: null,
  lastFailureReason: null,
  archivedAt: null,
  consumption: {
    workflowCount: 0,
    turnsUsed: 0,
    spendUsed: '0.0000',
    computeCostBasis: '0.0000',
  },
  ...overrides,
})

const group = (overrides: Partial<PoolGroup> = {}): PoolGroup => ({
  credentialGroupId: 'group-1',
  credentialGroupName: 'vendor pool',
  enabled: true,
  seatCount: 1,
  selectableCount: 1,
  holders: { running: 0, paused: 0, parked: 0, keepAlive: 0, other: 0, total: 0 },
  queue: { depth: 0, longestWaitMs: null, waitingSince: null },
  pressure: 'available',
  seats: [seat()],
  ...overrides,
})

const view = (overrides: Partial<PoolView> = {}): PoolView => ({
  observedAt: now,
  groups: [group()],
  seatCount: 1,
  selectableCount: 1,
  holders: { running: 0, paused: 0, parked: 0, keepAlive: 0, other: 0, total: 0 },
  queue: { depth: 0, longestWaitMs: null, waitingSince: null, unattributableDepth: 0 },
  verdict: 'healthy',
  starvedGroupNames: [],
  ...overrides,
})

describe('formatDuration', () => {
  it('renders hold times and waits in the units a person compares them in', () => {
    // Not `formatElapsed`, which renders `m:ss` for a button that has been working for four
    // seconds. A seat held for two days is not `2880:00`.
    expect(formatDuration(30_000)).toBe('under a minute')
    expect(formatDuration(9 * 60_000)).toBe('9m')
    expect(formatDuration(5 * 3_600_000)).toBe('5h')
    expect(formatDuration(50 * 3_600_000)).toBe('2d')
  })

  it('reads as a word rather than an empty cell when there is nothing to measure', () => {
    expect(formatDuration(null)).toBe(NO_DURATION)
    expect(formatDuration(Number.NaN)).toBe(NO_DURATION)
  })
})

describe('toPoolSummary — the SC-011 sentence', () => {
  it('does not claim spare capacity when nothing is waiting', () => {
    // A pool with every seat held and nothing queued is fully utilised and correctly sized. Telling
    // an administrator it is "fine" would be a lie in the direction that costs money.
    const summary = toPoolSummary(view())

    expect(summary.headline).toBe('No run is waiting for an agent credential.')
    expect(summary.detail).toContain('fully utilised rather than short')
  })

  it('calls it an under-sized pool only when no group anywhere has a free seat', () => {
    const summary = toPoolSummary(
      view({
        verdict: 'pool_undersized',
        selectableCount: 0,
        queue: { depth: 3, longestWaitMs: 900_000, waitingSince: now, unattributableDepth: 0 },
        starvedGroupNames: ['vendor pool'],
      }),
    )

    expect(summary.headline).toContain('The pool is under-sized')
    expect(summary.headline).toContain('3 waiting')
    // Points at the holder breakdown, because a pool full of parked runs is the likeliest reason a
    // pool looks idle and behaves as though it is full (FR-074).
    expect(summary.detail).toContain('parked run consumes capacity indefinitely')
  })

  it('names the short groups, and says platform-wide capacity will not clear the queue (FR-063)', () => {
    // The common case, and the one an aggregate number hides. Free seats exist; these runs are not
    // permitted to draw on them, because their profiles are attached to other groups.
    const summary = toPoolSummary(
      view({
        verdict: 'group_undersized',
        selectableCount: 4,
        queue: { depth: 2, longestWaitMs: 600_000, waitingSince: now, unattributableDepth: 0 },
        starvedGroupNames: ['vendor pool', 'overflow pool'],
      }),
    )

    expect(summary.headline).toContain('vendor pool, overflow pool')
    expect(summary.headline).toContain('are under-sized')
    expect(summary.headline).toContain('the pool as a whole is not')
    expect(summary.detail).toContain('Buying platform-wide capacity would not clear this queue')
    expect(summary.detail).toContain('adding seats to vendor pool, overflow pool')
  })

  it('agrees with itself about number when one group is short', () => {
    const summary = toPoolSummary(
      view({
        verdict: 'group_undersized',
        selectableCount: 1,
        queue: { depth: 1, longestWaitMs: 1_000, waitingSince: now, unattributableDepth: 0 },
        starvedGroupNames: ['vendor pool'],
      }),
    )

    expect(summary.headline).toContain('vendor pool is under-sized')
  })
})

describe('describeHolders (FR-074)', () => {
  it('names all four kinds, zeroes included', () => {
    // FR-074 exists because a pool full of parked holders is indistinguishable from an idle one in
    // any summary that counts only "in use". A line that dropped its zeroes would make `parked 0` an
    // absence to notice rather than a nought to read.
    expect(
      describeHolders({ running: 2, paused: 0, parked: 3, keepAlive: 1, other: 0, total: 6 }),
    ).toBe('running 2 · paused 0 · parked 3 · keep-alive 1')
  })

  it('shows the residual kind only when it is non-zero, so the line stays scannable', () => {
    expect(
      describeHolders({ running: 0, paused: 0, parked: 0, keepAlive: 0, other: 2, total: 2 }),
    ).toContain('other 2')
  })
})

describe('toPoolSeatReadout', () => {
  it('names a parked holder and how long it has held the seat', () => {
    const readout = toPoolSeatReadout(
      seat({
        state: 'held',
        selectable: false,
        holder: {
          kind: 'parked',
          workflowId: 'workflow-77',
          workflowState: 'parked_resumable',
          acquiredAt: new Date(now.getTime() - 172_800_000),
          heldForMs: 172_800_000,
        },
      }),
    )

    expect(readout.holder).toBe('parked · workflow-77 · 2d')
    expect(readout.holderWorkflowState).toBe('parked_resumable')
  })

  it('names a keep-alive as the routine exercise it is, not as a holder to chase', () => {
    // An administrator who read a liveness check as a stuck seat would go looking for a run to
    // force-release that does not exist — a keep-alive has no workflow and takes no lease.
    const readout = toPoolSeatReadout(
      seat({
        state: 'held',
        selectable: false,
        holder: {
          kind: 'keep_alive',
          workflowId: null,
          workflowState: null,
          acquiredAt: null,
          heldForMs: null,
        },
      }),
    )

    expect(readout.holder).toContain('keep-alive exercise')
    expect(readout.holderWorkflowState).toBeUndefined()
  })

  it('renders a failure reason verbatim (FR-009)', () => {
    const readout = toPoolSeatReadout(
      seat({
        state: 'unhealthy',
        health: 'unhealthy',
        selectable: false,
        lastFailureReason: 'the provider rejected the session: credentials expired 2026-08-04',
      }),
    )

    expect(readout.lastFailureReason).toBe(
      'the provider rejected the session: credentials expired 2026-08-04',
    )
  })

  it('reports inference and compute as separate figures, never blended (FR-039)', () => {
    const readout = toPoolSeatReadout(
      seat({
        consumption: {
          workflowCount: 3,
          turnsUsed: 22,
          spendUsed: '8.5000',
          computeCostBasis: '1.2500',
        },
      }),
    )

    expect(readout.consumption).toContain('8.5000 inference')
    expect(readout.consumption).toContain('1.2500 compute')
  })
})

describe('toPoolGroupReadout', () => {
  it('says a starved group needs seats, and how long the wait already is', () => {
    const readout = toPoolGroupReadout(
      group({
        pressure: 'starved',
        selectableCount: 0,
        queue: { depth: 2, longestWaitMs: 3_600_000, waitingSince: now },
      }),
    )

    expect(readout.verdict).toContain('2 waiting')
    expect(readout.verdict).toContain('longest 1h')
    expect(readout.verdict).toContain('needs more seats')
  })

  it('says a full group is fully utilised rather than short', () => {
    const readout = toPoolGroupReadout(group({ pressure: 'full', selectableCount: 0 }))

    expect(readout.verdict).toContain('fully utilised, not short')
  })

  it('keeps a group that holds no credential at all — the most under-sized case there is', () => {
    const readout = toPoolGroupReadout(
      group({
        seats: [],
        seatCount: 0,
        selectableCount: 0,
        pressure: 'starved',
        queue: { depth: 3, longestWaitMs: 60_000, waitingSince: now },
      }),
    )

    expect(readout.seats).toStrictEqual([])
    expect(readout.queueDepth).toBe('3')
  })
})
