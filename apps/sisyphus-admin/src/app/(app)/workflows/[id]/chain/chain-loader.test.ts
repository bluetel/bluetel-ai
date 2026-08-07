import type { ChainMember } from '@sisyphus-admin/components/workflows/chain'
import { describe, expect, it } from 'vitest'

import type { SuccessorChainResult } from './chain-loader'
import { createChainLoader } from './chain-loader'

/**
 * The loader that makes the chain view traversable both ways (T102, FR-152, FR-190).
 *
 * The property under test is the one the backwards walk cannot hold: that a run opened in the
 * *middle* of a chain reaches the runs that continue it, and that the panel is told the forward
 * direction is established rather than left to say it is not.
 */

const OLDEST = '0199a1f4-0000-7000-8000-000000000001'
const MIDDLE = '0199a1f4-0000-7000-8000-000000000002'
const NEWEST = '0199a1f4-0000-7000-8000-000000000003'

const link = (workflowId: string, predecessorWorkflowId: string | null): unknown => ({
  workflowId,
  predecessorWorkflowId,
  type: 'delegated',
  state: 'succeeded',
  terminalOutcome: 'succeeded',
  outcomeReason: null,
  model: 'claude-opus-5',
  turnCap: 40,
  spendCap: '25.0000',
  turnsUsed: 4,
  spendUsed: '1.0000',
  sessionId: workflowId,
  createdAt: new Date('2026-08-05T09:00:00.000Z'),
  isRequested: workflowId === MIDDLE,
})

const chain = (links: readonly unknown[]): SuccessorChainResult =>
  ({
    requestedWorkflowId: MIDDLE,
    links,
    workflowCount: links.length,
    turnsTotal: 12,
    spendTotal: '3.0000',
  }) as unknown as SuccessorChainResult

const wholeChain = (): SuccessorChainResult =>
  chain([link(OLDEST, null), link(MIDDLE, OLDEST), link(NEWEST, MIDDLE)])

const member = (workflowId: string, predecessorWorkflowId: string | null): ChainMember =>
  ({
    workflowId,
    predecessorWorkflowId,
    state: 'succeeded',
    terminalOutcome: 'succeeded',
    model: 'claude-opus-5',
    turnCap: 40,
    spendCap: '25.0000',
    turnsUsed: 4,
    spendUsed: '1.0000',
    createdAt: new Date('2026-08-05T09:00:00.000Z'),
    updatedAt: new Date('2026-08-05T09:30:00.000Z'),
  }) satisfies ChainMember

const predecessorOf = new Map<string, string | null>([
  [OLDEST, null],
  [MIDDLE, OLDEST],
  [NEWEST, MIDDLE],
])

const readMember = (workflowId: string): Promise<ChainMember | undefined> => {
  const predecessor = predecessorOf.get(workflowId)

  return Promise.resolve(predecessor === undefined ? undefined : member(workflowId, predecessor))
}

describe('createChainLoader', () => {
  it('reaches the run that continues this one — the direction a backwards walk cannot (FR-152)', async () => {
    const load = createChainLoader({ readChain: () => Promise.resolve(wholeChain()), readMember })

    const loaded = await load(MIDDLE)

    expect(loaded.members.map((one) => one.workflowId)).toStrictEqual([OLDEST, MIDDLE, NEWEST])
  })

  it('reports both directions established, so the panel may say what the end of the chain is', async () => {
    const load = createChainLoader({ readChain: () => Promise.resolve(wholeChain()), readMember })

    expect((await load(MIDDLE)).completeness).toStrictEqual({
      reachedRoot: true,
      reachedLatest: true,
    })
  })

  it('does not claim to have reached the root when the oldest link continues something', async () => {
    const load = createChainLoader({
      readChain: () => Promise.resolve(chain([link(MIDDLE, OLDEST), link(NEWEST, MIDDLE)])),
      readMember,
    })

    const loaded = await load(MIDDLE)

    expect(loaded.completeness.reachedRoot).toBe(false)
    expect(loaded.completeness.reachedLatest).toBe(true)
  })

  it('claims neither direction when a member could not be read back', async () => {
    const load = createChainLoader({
      readChain: () => Promise.resolve(wholeChain()),
      readMember: async (workflowId) =>
        workflowId === NEWEST ? undefined : readMember(workflowId),
    })

    const loaded = await load(MIDDLE)

    expect(loaded.members).toHaveLength(2)
    expect(loaded.completeness).toStrictEqual({ reachedRoot: false, reachedLatest: false })
  })

  it('renders a refused chain as no chain, exactly as an absent run reads (FR-190)', async () => {
    const load = createChainLoader({
      readChain: () => Promise.reject(new Error('NOT_FOUND')),
      readMember,
    })

    await expect(load(MIDDLE)).resolves.toStrictEqual({
      members: [],
      completeness: { reachedRoot: false, reachedLatest: false },
    })
  })

  it('treats an empty chain as no chain rather than as a chain of nothing', async () => {
    const load = createChainLoader({ readChain: () => Promise.resolve(chain([])), readMember })

    expect((await load(MIDDLE)).members).toStrictEqual([])
  })
})
