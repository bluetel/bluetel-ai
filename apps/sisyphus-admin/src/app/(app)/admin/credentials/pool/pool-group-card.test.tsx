import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PoolGroupCard } from './pool-group-card'
import type { PoolGroupReadout, PoolSeatReadout } from './pool-readout'

/**
 * One group's card (T113, FR-053, FR-054, FR-074).
 *
 * The assertions are about what an administrator can *see* without clicking: the group's own queue
 * beside its own free-seat count, the holder kinds named rather than totalled, and the group with no
 * seats present rather than absent.
 */

const seat = (overrides: Partial<PoolSeatReadout> = {}): PoolSeatReadout => ({
  id: 'seat-1',
  name: 'vendor-seat-1',
  state: 'available',
  health: 'healthy',
  selectable: true,
  holder: 'free',
  lastUsed: 'never',
  lastExercised: 'never',
  consumption: '0 runs · 0 turns · 0.0000 inference · 0.0000 compute',
  archived: false,
  ...overrides,
})

const group = (overrides: Partial<PoolGroupReadout> = {}): PoolGroupReadout => ({
  id: 'group-1',
  name: 'vendor pool',
  enabled: true,
  pressure: 'available',
  verdict: '2 of 3 seats free',
  seatCount: '3',
  selectableCount: '2',
  queueDepth: '0',
  longestWait: '—',
  holders: 'running 1 · paused 0 · parked 0 · keep-alive 0',
  seats: [seat()],
  ...overrides,
})

const render = (overrides: Partial<PoolGroupReadout> = {}) =>
  renderToStaticMarkup(<PoolGroupCard group={group(overrides)} />)

describe('PoolGroupCard', () => {
  it('puts the group’s queue next to the seats it has free (SC-011)', () => {
    const markup = render({
      pressure: 'starved',
      verdict: '2 waiting, longest 1h — this group needs more seats',
      selectableCount: '0',
      queueDepth: '2',
      longestWait: '1h',
    })

    expect(markup).toContain('waiting')
    expect(markup).toContain('longest wait')
    expect(markup).toContain('free now')
    expect(markup).toContain('this group needs more seats')
  })

  it('names every holder kind rather than reporting a total (FR-074)', () => {
    const markup = render({ holders: 'running 1 · paused 0 · parked 4 · keep-alive 0' })

    expect(markup).toContain('parked 4')
    expect(markup).toContain('keep-alive 0')
  })

  it('shows a group that holds no credential at all — the most under-sized case there is', () => {
    // A layout built outward from credentials would have omitted exactly the group most in need of
    // buying for.
    const markup = render({ seats: [], seatCount: '0', selectableCount: '0', pressure: 'starved' })

    expect(markup).toContain('vendor pool')
    expect(markup).toContain('this group holds no agent credential')
  })

  it('says what disabling a group did, and what it did not do (FR-006 group-wide)', () => {
    const markup = render({ enabled: false })

    expect(markup).toContain('withheld from future selection')
    expect(markup).toContain('keep it until they finish')
  })

  it('renders a seat’s failure reason in full, against the seat it belongs to (FR-009)', () => {
    const markup = render({
      seats: [
        seat({
          state: 'unhealthy',
          health: 'unhealthy',
          selectable: false,
          holder: 'held by nobody',
          lastFailureReason: 'the provider rejected the session: credentials expired 2026-08-04',
        }),
      ],
    })

    expect(markup).toContain('the provider rejected the session: credentials expired 2026-08-04')
  })

  it('reports what a seat has consumed, per credential (FR-055)', () => {
    const markup = render({
      seats: [seat({ consumption: '3 runs · 22 turns · 8.5000 inference · 1.2500 compute' })],
    })

    expect(markup).toContain('8.5000 inference')
    expect(markup).toContain('1.2500 compute')
  })

  it('carries no credential material, because the shape it renders has none (FR-011, SC-014)', () => {
    // `PoolSeatReadout` has no field a token could be put in, and neither does the query behind it —
    // the pool view reports whether a login was captured, never the identifier it was filed under.
    const markup = render({
      seats: [seat({ health: 'never_logged_in', state: 'awaiting_login', selectable: false })],
    })

    expect(markup).not.toContain('secret')
  })
})
