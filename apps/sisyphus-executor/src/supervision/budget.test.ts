import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentQuiescedState } from '../agent'
import type { SnapshotPort } from '../session'
import { suspend } from '../session'

import {
  ACKNOWLEDGE_BUDGET_MS,
  PAUSE_LATENCY_CEILING_MS,
  pauseLatencyBudget,
  POLL_INTERVAL_MS,
  PULL_ROUND_TRIP_MS,
  QUIESCE_BUDGET_MS,
  SNAPSHOT_BUDGET_MS,
  SNAPSHOT_CAPTURE_BUDGET_MS,
  SNAPSHOT_REGISTER_BUDGET_MS,
} from './budget'
import type { SupervisionTransport } from './poll'
import { createSupervisionPoller } from './poll'

/**
 * SC-003 is a number, so it is worth asserting as one.
 *
 * These tests fail if somebody widens a term without widening the ceiling — which is the edit that
 * quietly makes the pause path miss its deadline while every other test still passes.
 *
 * **They are not, on their own, a test of SC-003.** FR-205 says so plainly: a test that adds
 * numbers together keeps passing when the operation is slow, and when the operation never runs at
 * all. Everything above the last `describe` in this file is the declared intent; the last one
 * performs a pause and measures it.
 */

describe('the SC-003 pause budget', () => {
  it('fits inside the ten seconds, with slack held back rather than spent', () => {
    const budget = pauseLatencyBudget()

    expect(budget.ceilingMs).toBe(PAUSE_LATENCY_CEILING_MS)
    expect(budget.totalMs).toBe(9_000)
    expect(budget.slackMs).toBe(1_000)
    expect(budget.totalMs).toBeLessThan(budget.ceilingMs)
  })

  it('sums the terms rather than restating a total', () => {
    const budget = pauseLatencyBudget()
    const summed = budget.terms.reduce((total, term) => total + term.budgetMs, 0)

    expect(budget.totalMs).toBe(summed)
    expect(summed).toBe(
      POLL_INTERVAL_MS +
        PULL_ROUND_TRIP_MS +
        QUIESCE_BUDGET_MS +
        SNAPSHOT_BUDGET_MS +
        ACKNOWLEDGE_BUDGET_MS,
    )
  })

  it('names every term of the path, so none is budgeted by omission', () => {
    expect(pauseLatencyBudget().terms.map((term) => term.name)).toStrictEqual([
      'poll-interval',
      'pull-round-trip',
      'quiesce',
      'snapshot',
      'acknowledge',
    ])
  })

  it('gives quiesce the largest share, because it is the term that bounds turn length', () => {
    const budget = pauseLatencyBudget()
    const [largest] = [...budget.terms].sort((left, right) => right.budgetMs - left.budgetMs)

    expect(largest.name).toBe('quiesce')
  })

  it('keeps the poll interval a small fraction of the ceiling', () => {
    // A five-second interval would consume half the budget in the first term alone.
    expect(POLL_INTERVAL_MS).toBeLessThanOrEqual(PAUSE_LATENCY_CEILING_MS / 4)
  })

  it('leaves the acknowledgement inside the budget, because that is when the user is told', () => {
    // FR-049 puts acknowledgement after snapshot registration, so both terms are inside SC-003.
    const budget = pauseLatencyBudget()
    const names = budget.terms.map((term) => term.name)

    expect(names).toContain('snapshot')
    expect(names.indexOf('acknowledge')).toBeGreaterThan(names.indexOf('snapshot'))
  })

  it('divides the snapshot term between the two operations it names, rather than over both', () => {
    // The discrepancy measuring found. "Capture *and* `registerSnapshot`" is two sequential
    // operations under one 1500 ms heading. Bounding each of them at 1500 makes the real worst
    // case 10 500 ms — over SC-003's ceiling — while `totalMs` goes on reporting 9000. The two
    // sub-terms are what keep the enforced bound and the declared one the same number.
    expect(SNAPSHOT_CAPTURE_BUDGET_MS + SNAPSHOT_REGISTER_BUDGET_MS).toBe(SNAPSHOT_BUDGET_MS)
  })
})

/**
 * **SC-003, measured (T189, FR-205).**
 *
 * Everything above restates the budget. This performs the pause — the poll loop collecting the
 * row, `suspend()` reaching a turn boundary, capturing and registering, and the acknowledgement
 * that is the moment the panel may say "paused" — and observes the elapsed time from the instant
 * the command landed to the instant it was acknowledged.
 *
 * Every injected operation consumes exactly its declared term, so what is being measured is
 * whether the *composition* fits: whether the path has terms nobody budgeted for, whether a term
 * is spent twice, and whether the poll loop and `suspend()` in fact wait for the things the table
 * says they wait for. Fake timers, so the suite pays no real seconds for a nine-second budget —
 * the arithmetic is simulated but the control flow is the production control flow.
 */
describe('the SC-003 pause path, measured rather than summed', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const SESSION = '01890a5d-ac96-774b-bcce-b302099a8057'

  const delay = async (milliseconds: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds)
    })

  /**
   * Drive one pause end to end and answer with how long it took.
   *
   * @param overrides - Per-operation costs, for the tests that make one term overrun.
   * @returns The elapsed simulated milliseconds from the row landing to the acknowledgement, and
   *   what the poller recorded about the command.
   */
  const measurePause = async (
    overrides: {
      readonly quiesceMs?: number
      readonly captureMs?: number
    } = {},
  ): Promise<{ readonly elapsedMs: number; readonly outcome: string | undefined }> => {
    vi.useFakeTimers()

    let pulls = 0
    let landedAt: number | undefined
    let acknowledgedAt: number | undefined
    let outcome: string | undefined

    const transport: SupervisionTransport = {
      pullPendingCommands: async () => {
        await delay(PULL_ROUND_TRIP_MS)
        pulls += 1

        if (pulls === 1) {
          // SC-003's first term is the worst case, so the row is written the instant *after* a
          // poll returned: the whole interval is spent before anything has even looked.
          landedAt = Date.now()

          return []
        }

        if (pulls !== 2) {
          return []
        }

        return [
          {
            id: 'c1',
            command: 'pause' as const,
            sequence: 1,
            deliveryOutcome: 'pending' as const,
            failureReason: null,
          },
        ]
      },
      acknowledgeCommand: async (acknowledgement) => {
        await delay(ACKNOWLEDGE_BUDGET_MS)
        acknowledgedAt ??= Date.now()
        outcome ??= acknowledgement.outcome
      },
    }

    const snapshot: SnapshotPort = {
      capture: async () => {
        await delay(overrides.captureMs ?? SNAPSHOT_CAPTURE_BUDGET_MS)

        return {
          s3Key: 'snapshots/pause.tar.zst',
          sizeBytes: 1_024,
          hasConversationState: true,
          hasWorktreeState: true,
        }
      },
    }

    const poller = createSupervisionPoller({
      transport,
      handlers: {
        onPause: async () => {
          await suspend({
            reason: 'pause',
            sessionId: SESSION,
            workspaceRoot: '/srv/sisyphus/workspace',
            snapshot,
            agent: {
              quiesce: async (): Promise<AgentQuiescedState> => {
                await delay(overrides.quiesceMs ?? QUIESCE_BUDGET_MS)

                return {
                  waitedForTurn: true,
                  usage: { turns: 3, spendUsd: 0.5 },
                }
              },
              stop: (): Promise<unknown> => Promise.resolve(undefined),
            },
            registerSnapshot: async () => {
              await delay(SNAPSHOT_REGISTER_BUDGET_MS)
            },
          })
        },
        onStop: (): Promise<void> => Promise.resolve(),
      },
    })

    const running = poller.run()

    // Generous: the loop is stepped until the pause has been applied and acknowledged, and the
    // measurement is taken from the timestamps rather than from how long this ran for.
    await vi.advanceTimersByTimeAsync(PAUSE_LATENCY_CEILING_MS * 3)
    poller.stop()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    await running

    if (landedAt === undefined || acknowledgedAt === undefined) {
      throw new Error('the pause was never applied, which is the failure FR-205 is about')
    }

    return { elapsedMs: acknowledgedAt - landedAt, outcome }
  }

  it('takes effect inside SC-003’s ten seconds when every term costs exactly its budget', async () => {
    const { elapsedMs, outcome } = await measurePause()

    expect(outcome).toBe('acknowledged')
    expect(elapsedMs).toBeLessThanOrEqual(PAUSE_LATENCY_CEILING_MS)
  })

  it('costs exactly what the table says it costs, term for term', async () => {
    const { elapsedMs } = await measurePause()

    // Not `toBeLessThan`: a path that came in comfortably under would mean a term the table
    // charges for is not actually being waited on, which is the other way this can be wrong.
    expect(elapsedMs).toBe(pauseLatencyBudget().totalMs)
  })

  it('fails the pause rather than snapshotting mid-turn when the quiesce term is blown', async () => {
    // The bound with teeth. A turn that will not reach a boundary inside its term makes SC-003
    // unmeetable, and the answer is a rejected pause on a run that is still running — never a
    // snapshot of a tree the agent is halfway through editing.
    const { outcome } = await measurePause({ quiesceMs: QUIESCE_BUDGET_MS * 3 })

    expect(outcome).toBe('rejected')
  })
})
