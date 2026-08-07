import { describe, expect, it } from 'vitest'

import type { ChainMember } from './chain-model'
import {
  chainNeighbours,
  chainStateReadout,
  orderChain,
  summariseChain,
  toChainReadouts,
} from './chain-model'

/**
 * The chain's decisions, asserted without a network. Ordering, both neighbours, the totals and
 * every readout are decided here so the panel renders rather than reasons.
 */

const AT = (minutes: number): Date => new Date(Date.UTC(2026, 7, 5, 9, minutes, 0))

const member = (
  overrides: Partial<ChainMember> & { readonly workflowId: string },
): ChainMember => ({
  predecessorWorkflowId: null,
  state: 'succeeded',
  terminalOutcome: 'succeeded',
  model: 'claude-opus-5',
  turnCap: 40,
  spendCap: '25.0000',
  turnsUsed: 3,
  spendUsed: '11.0000',
  createdAt: AT(0),
  updatedAt: AT(10),
  ...overrides,
})

const A = member({ workflowId: 'run-a', createdAt: AT(0) })
const B = member({ workflowId: 'run-b', predecessorWorkflowId: 'run-a', createdAt: AT(1) })
const C = member({ workflowId: 'run-c', predecessorWorkflowId: 'run-b', createdAt: AT(2) })

describe('orderChain', () => {
  it('orders oldest first by following the predecessor links, not by timestamp', () => {
    expect(orderChain([C, A, B]).map((link) => link.workflowId)).toStrictEqual([
      'run-a',
      'run-b',
      'run-c',
    ])
  })

  it('orders a chain whose members all share a timestamp', () => {
    const flat = [
      member({ workflowId: 'x', createdAt: AT(0) }),
      member({ workflowId: 'y', predecessorWorkflowId: 'x', createdAt: AT(0) }),
      member({ workflowId: 'z', predecessorWorkflowId: 'y', createdAt: AT(0) }),
    ]

    expect(
      orderChain([flat[2], flat[0], flat[1]] as ChainMember[]).map((l) => l.workflowId),
    ).toStrictEqual(['x', 'y', 'z'])
  })

  it('starts from the earliest visible run when the true root is out of scope (FR-190)', () => {
    // B and C are visible; A is not, so B's predecessor points at nothing the caller can see.
    expect(orderChain([C, B]).map((link) => link.workflowId)).toStrictEqual(['run-b', 'run-c'])
  })

  it('still lists a run the walk cannot reach, rather than dropping it', () => {
    const orphan = member({ workflowId: 'orphan', predecessorWorkflowId: 'gone', createdAt: AT(9) })

    expect(orderChain([A, B, orphan]).map((link) => link.workflowId)).toStrictEqual([
      'run-a',
      'run-b',
      'orphan',
    ])
  })

  it('terminates on a cycle rather than walking it forever', () => {
    const left = member({ workflowId: 'l', predecessorWorkflowId: 'r', createdAt: AT(0) })
    const right = member({ workflowId: 'r', predecessorWorkflowId: 'l', createdAt: AT(1) })

    expect(orderChain([left, right])).toHaveLength(2)
  })

  it('is a chain of one for a run that continues nothing', () => {
    expect(orderChain([A].map((link) => link))).toStrictEqual([A])
  })
})

describe('chainNeighbours', () => {
  it('finds the run before and the run after — both directions (FR-152)', () => {
    const { previous, next } = chainNeighbours([A, B, C], 'run-b')

    expect(previous?.workflowId).toBe('run-a')
    expect(next?.workflowId).toBe('run-c')
  })

  it('has no previous at the start of the chain', () => {
    expect(chainNeighbours([A, B, C], 'run-a').previous).toBeUndefined()
  })

  it('has no next at the end of the chain', () => {
    expect(chainNeighbours([A, B, C], 'run-c').next).toBeUndefined()
  })

  it('answers with neither for a run that is not in the set', () => {
    expect(chainNeighbours([A, B, C], 'run-z')).toStrictEqual({
      previous: undefined,
      next: undefined,
    })
  })

  it('looks the neighbour up on the link, not on the position in the array', () => {
    // `run-c` follows `run-b` in the array but continues nothing visible: its predecessor is gone.
    const detached = member({ workflowId: 'run-c', predecessorWorkflowId: 'gone' })

    expect(chainNeighbours([A, detached], 'run-a').next).toBeUndefined()
  })
})

describe('summariseChain', () => {
  it('sums consumption across the chain (FR-152)', () => {
    const totals = summariseChain([
      member({ workflowId: 'a', turnsUsed: 3, spendUsed: '11.0000' }),
      member({ workflowId: 'b', turnsUsed: 5, spendUsed: '7.5000' }),
    ])

    expect(totals).toStrictEqual({ workflowCount: 2, turnsTotal: 8, spendTotal: '18.5000' })
  })

  it('answers zero for an empty chain rather than a blank', () => {
    expect(summariseChain([])).toStrictEqual({
      workflowCount: 0,
      turnsTotal: 0,
      spendTotal: '0.0000',
    })
  })

  it('sums only what it was given, which under FR-190 is what the caller may see', () => {
    // The whole chain is three runs; two are visible, and the total is a total of two.
    expect(summariseChain([B, C]).workflowCount).toBe(2)
  })
})

describe('chainStateReadout', () => {
  it('carries elapsed time for a run still in flight', () => {
    const live = member({ workflowId: 'live', state: 'running', createdAt: AT(0) })

    expect(chainStateReadout(live, AT(3).getTime())).toBe('running 3:00')
  })

  it('reads a settled run without a running clock', () => {
    expect(chainStateReadout(A, AT(30).getTime())).toBe('succeeded')
  })

  it('unpicks the underscore in a multi-word state', () => {
    expect(
      chainStateReadout(member({ workflowId: 'p', state: 'parked_resumable' }), undefined),
    ).toBe('parked resumable')
  })
})

describe('toChainReadouts', () => {
  it('numbers the runs from one, oldest first, and marks the requested one', () => {
    const readouts = toChainReadouts([A, B, C], 'run-b', undefined)

    expect(readouts.map((row) => row.position)).toStrictEqual([1, 2, 3])
    expect(readouts.map((row) => row.isRequested)).toStrictEqual([false, true, false])
  })

  it('says what each run’s place in the chain is', () => {
    const readouts = toChainReadouts([A, B, C], 'run-a', undefined)

    expect(readouts[0]?.relation).toContain('first run')
    expect(readouts[1]?.relation).toBe('continued from and by')
    expect(readouts[2]?.relation).toContain('latest run')
  })

  it('says so plainly when the chain is one run long', () => {
    expect(toChainReadouts([A], 'run-a', undefined)[0]?.relation).toBe('the only run in this chain')
  })

  it('reports consumption per run against its cap (FR-152)', () => {
    const readouts = toChainReadouts([A], 'run-a', undefined)

    expect(readouts[0]?.turns).toBe('3 / 40')
    expect(readouts[0]?.spend).toBe('11.0000 / 25.0000')
  })

  it('never renders an uncapped run as a cap of zero', () => {
    const uncapped = member({ workflowId: 'u', turnCap: null, spendCap: null })
    const readouts = toChainReadouts([uncapped], 'u', undefined)

    expect(readouts[0]?.turns).toBe('3 (uncapped)')
    expect(readouts[0]?.spend).toBe('11.0000 (uncapped)')
  })

  it('passes spend through as the decimal string the platform recorded', () => {
    expect(toChainReadouts([A], 'run-a', undefined)[0]?.spend).toContain('11.0000')
  })
})
