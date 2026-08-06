import { describe, expect, it } from 'vitest'

import type { ReviewTargetState } from './review-guard'
import { createReviewGuard, isDeadTargetState, openTargetGuard } from './review-guard'
import type { ReviewTarget } from './review-step'

/**
 * A review whose target is already gone stops without touching anything (FR-080).
 */

const target = (number: number, entryId = 'entry-a'): ReviewTarget => ({
  entryId,
  repository: 'git.test/app',
  pullRequestNumber: number,
  pullRequestUrl: `https://git.test/app/pull/${String(number)}`,
})

const fixedProbe =
  (states: Readonly<Record<number, ReviewTargetState>>) =>
  async (given: ReviewTarget): Promise<ReviewTargetState> =>
    Promise.resolve(states[given.pullRequestNumber] ?? 'open')

describe('isDeadTargetState', () => {
  it('counts closed and merged, and nothing else', () => {
    expect(isDeadTargetState('closed')).toBe(true)
    expect(isDeadTargetState('merged')).toBe(true)
    expect(isDeadTargetState('open')).toBe(false)
    expect(isDeadTargetState('unknown')).toBe(false)
  })
})

describe('createReviewGuard', () => {
  it('lets an open target through', async () => {
    const guard = createReviewGuard({ targets: [target(7)], probe: fixedProbe({}) })

    const decision = await guard.checkpoint('start')

    expect(decision.action).toBe('continue')
  })

  it('stops at the start with a no-op outcome, posting nothing and moving nothing', async () => {
    const guard = createReviewGuard({ targets: [target(7)], probe: fixedProbe({ 7: 'merged' }) })

    const decision = await guard.checkpoint('start')

    expect(decision.action).toBe('stop')
    if (decision.action !== 'stop') {
      return
    }

    expect(decision.outcome.outcome).toBe('succeeded')
    expect(decision.outcome.commentsPosted).toBe(0)
    expect(decision.outcome.ticketTransitioned).toBe(false)
    expect(decision.outcome.reason).toContain('No-op')
    expect(decision.outcome.reason).toContain('nothing left to review when this run started')
  })

  it('reports a target that died mid-run at the checkpoint that caught it', async () => {
    let state: ReviewTargetState = 'open'
    const guard = createReviewGuard({
      targets: [target(7)],
      probe: async () => Promise.resolve(state),
    })

    expect((await guard.checkpoint('start')).action).toBe('continue')
    state = 'closed'
    const decision = await guard.checkpoint('before_findings')

    expect(decision.action).toBe('stop')
    if (decision.action !== 'stop') {
      return
    }

    expect(decision.outcome.checkpoint).toBe('before_findings')
    expect(decision.outcome.reason).toContain('changed while this run was in flight')
    expect(decision.outcome.reason).toContain('before_findings')
  })

  it('names which pull request of a set went away', async () => {
    const guard = createReviewGuard({
      targets: [target(7, 'entry-a'), target(9, 'entry-b')],
      probe: fixedProbe({ 9: 'merged' }),
    })

    const decision = await guard.checkpoint('before_ticket')

    expect(decision.action).toBe('stop')
    if (decision.action !== 'stop') {
      return
    }

    expect(decision.outcome.dead).toHaveLength(1)
    expect(decision.outcome.reason).toContain('#9 is merged')
    expect(decision.outcome.reason).not.toContain('#7')
  })

  it('does not treat a forge it could not ask as a dead target', async () => {
    const guard = createReviewGuard({ targets: [target(7)], probe: fixedProbe({ 7: 'unknown' }) })

    expect((await guard.checkpoint('start')).action).toBe('continue')
  })

  it('propagates a probe that threw rather than calling the run a no-op', async () => {
    const guard = createReviewGuard({
      targets: [target(7)],
      probe: async () => Promise.reject(new Error('the forge is unreachable')),
    })

    await expect(guard.checkpoint('start')).rejects.toThrow(/unreachable/u)
  })
})

describe('openTargetGuard', () => {
  it('continues, so a loop that just opened its own pull requests need not invent a probe', async () => {
    expect((await openTargetGuard([target(7)]).checkpoint('start')).action).toBe('continue')
  })
})
