import { describe, expect, it } from 'vitest'

import {
  inSequenceOrder,
  resolveSupersession,
  supersededExplanation,
  type UncollectedCommand,
} from './supersession'

/**
 * The supersession rule is entirely a matter of judgement and entirely without a database, so it is
 * asserted here rather than being inferred from whichever queue test happens to exercise it.
 *
 * The case that matters most is the last one: a `pause` arriving behind an uncollected `stop`.
 * Ordering alone does not save it — the executor applies in `sequence` order, so the stop is applied
 * first and the pause is still sitting there afterwards, pending against a run that no longer
 * exists.
 */

const queued = (
  id: string,
  command: UncollectedCommand['command'],
  sequence: number,
): UncollectedCommand => ({ id, command, sequence })

describe('resolveSupersession', () => {
  it('leaves an empty queue alone', () => {
    const outcome = resolveSupersession([], 'pause')

    expect(outcome).toMatchObject({ supersededIds: [], incomingIsSuperseded: false })
  })

  it('supersedes an uncollected pause when a stop arrives (the case the contract names)', () => {
    const outcome = resolveSupersession([queued('c1', 'pause', 1)], 'stop')

    expect(outcome.supersededIds).toStrictEqual(['c1'])
    expect(outcome.incomingIsSuperseded).toBe(false)
    expect(outcome.reason).toContain('stop')
  })

  it('supersedes an uncollected pause when a resume arrives, so neither is applied', () => {
    const outcome = resolveSupersession([queued('c1', 'pause', 4)], 'resume')

    expect(outcome.supersededIds).toStrictEqual(['c1'])
    expect(outcome.incomingIsSuperseded).toBe(false)
  })

  it('supersedes every uncollected command, not just the newest', () => {
    const outcome = resolveSupersession(
      [queued('c1', 'pause', 1), queued('c2', 'resume', 2), queued('c3', 'pause', 3)],
      'stop',
    )

    expect(outcome.supersededIds).toStrictEqual(['c1', 'c2', 'c3'])
  })

  it('marks the incoming command superseded when a stop is already uncollected', () => {
    const outcome = resolveSupersession([queued('c9', 'stop', 7)], 'pause')

    expect(outcome).toMatchObject({
      supersededIds: [],
      incomingIsSuperseded: true,
      supersededBy: 'stop',
    })
    expect(outcome.reason).toBe(supersededExplanation('stop'))
  })

  it('never supersedes an uncollected stop, whatever arrives after it', () => {
    for (const incoming of ['pause', 'resume', 'stop'] as const) {
      const outcome = resolveSupersession([queued('c9', 'stop', 7)], incoming)

      expect(outcome.supersededIds).toStrictEqual([])
      expect(outcome.incomingIsSuperseded).toBe(true)
    }
  })

  it('explains itself in a sentence the panel can render verbatim', () => {
    expect(supersededExplanation('stop')).toContain('overtaken by a stop')
    expect(supersededExplanation('stop')).toContain('never applied')
  })
})

describe('inSequenceOrder', () => {
  it('orders by sequence and not by arrival', () => {
    const ordered = inSequenceOrder([{ sequence: 3 }, { sequence: 1 }, { sequence: 2 }])

    expect(ordered.map((entry) => entry.sequence)).toStrictEqual([1, 2, 3])
  })

  it('does not mutate its input', () => {
    const input = [{ sequence: 2 }, { sequence: 1 }]
    inSequenceOrder(input)

    expect(input.map((entry) => entry.sequence)).toStrictEqual([2, 1])
  })
})
