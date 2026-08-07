import { describe, expect, it, vi } from 'vitest'

import type { ChainMember } from './chain-model'
import type { ChainMemberReader } from './chain-walk'
import { MAX_CHAIN_WALK, walkPredecessors } from './chain-walk'

/**
 * The backwards walk, asserted against a reader rather than a network.
 *
 * Two properties carry the requirement. A run the reader cannot return **stops** the walk instead
 * of being stepped over, because stepping over it would say that something sits between two visible
 * runs (FR-190). And the walk never claims the forward direction: `reachedLatest` is false, which
 * is what makes the panel say so rather than leave a blank that reads as "nothing continued this".
 */

const member = (id: string, predecessor: string | null): ChainMember => ({
  workflowId: id,
  predecessorWorkflowId: predecessor,
  state: 'succeeded',
  terminalOutcome: 'succeeded',
  model: 'claude-opus-5',
  turnCap: 40,
  spendCap: '25.0000',
  turnsUsed: 2,
  spendUsed: '4.0000',
  createdAt: new Date('2026-08-05T09:00:00.000Z'),
  updatedAt: new Date('2026-08-05T09:10:00.000Z'),
})

const readerOf = (members: readonly ChainMember[]): ChainMemberReader => {
  const byId = new Map(members.map((entry) => [entry.workflowId, entry]))

  return (id) => Promise.resolve(byId.get(id))
}

describe('walkPredecessors', () => {
  it('returns the requested run and every visible ancestor, oldest first', async () => {
    const chain = [member('a', null), member('b', 'a'), member('c', 'b')]

    const loaded = await walkPredecessors(readerOf(chain), 'c')

    expect(loaded.members.map((entry) => entry.workflowId)).toStrictEqual(['a', 'b', 'c'])
    expect(loaded.completeness.reachedRoot).toBe(true)
  })

  it('never claims the forward direction, because it cannot look that way', async () => {
    const loaded = await walkPredecessors(readerOf([member('a', null)]), 'a')

    expect(loaded.completeness.reachedLatest).toBe(false)
  })

  it('stops at a run the caller may not see rather than stepping over it (FR-190)', async () => {
    // `a` is out of scope. The walk keeps `b` and `c` and does not reach the root.
    const loaded = await walkPredecessors(readerOf([member('b', 'a'), member('c', 'b')]), 'c')

    expect(loaded.members.map((entry) => entry.workflowId)).toStrictEqual(['b', 'c'])
    expect(loaded.completeness.reachedRoot).toBe(false)
  })

  it('answers with nothing when the requested run itself is absent or out of scope', async () => {
    const loaded = await walkPredecessors(readerOf([]), 'a')

    expect(loaded.members).toStrictEqual([])
    expect(loaded.completeness).toStrictEqual({ reachedRoot: false, reachedLatest: false })
  })

  it('reads each run at most once, so a chain costs one request per run', async () => {
    const read = vi.fn(readerOf([member('a', null), member('b', 'a')]))

    await walkPredecessors(read, 'b')

    expect(read).toHaveBeenCalledTimes(2)
  })

  it('terminates on a cycle rather than walking it forever', async () => {
    const loaded = await walkPredecessors(readerOf([member('l', 'r'), member('r', 'l')]), 'l')

    expect(loaded.members.map((entry) => entry.workflowId)).toStrictEqual(['r', 'l'])
  })

  it('stops at the depth limit rather than following an unbounded chain', async () => {
    const long = Array.from({ length: MAX_CHAIN_WALK + 10 }, (_unused, index) =>
      member(`run-${String(index)}`, index === 0 ? null : `run-${String(index - 1)}`),
    )

    const loaded = await walkPredecessors(readerOf(long), `run-${String(long.length - 1)}`)

    expect(loaded.members).toHaveLength(MAX_CHAIN_WALK)
  })
})
