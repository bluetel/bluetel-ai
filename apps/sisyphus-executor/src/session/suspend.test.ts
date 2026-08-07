import { describe, expect, it } from 'vitest'

import type { AgentQuiescedState } from '../agent'
import { AgentAdapterError } from '../agent'

import { SnapshotBoundaryUnpersistedError } from './park'
import type { CapturedSnapshot, SnapshotPort, SuspendOptions, SuspendReason } from './suspend'
import { suspend, suspensionPlanFor } from './suspend'

/**
 * T091. The assertions that carry the requirement:
 *
 * - **acknowledgement comes after registration** (FR-049) — asserted on the recorded call order,
 *   because this is the rule most easily lost to an "acknowledge as early as possible" edit;
 * - pause, interruption and stop go through the *same* routine, differing only in the recorded
 *   reason and whether compute is released immediately (FR-054, R3);
 * - unreachable storage parks and retries, and nothing is acknowledged or released while it does —
 *   no turn is sent either, because the agent port is never touched between attempts (FR-082).
 */

const CAPTURED: CapturedSnapshot = {
  s3Key: 'snapshots/9f1d/pause.tar.zst',
  sizeBytes: 4_096,
  hasConversationState: true,
  hasWorktreeState: true,
}

const QUIESCED: AgentQuiescedState = {
  usage: { turns: 7, spendUsd: 1.25 },
  waitedForTurn: true,
}

interface Harness {
  readonly calls: string[]
  readonly options: SuspendOptions
}

const harnessFor = (
  reason: SuspendReason,
  overrides: Partial<SuspendOptions> = {},
  capture?: SnapshotPort['capture'],
): Harness => {
  const calls: string[] = []

  return {
    calls,
    options: {
      reason,
      sessionId: '9f1d1b3e-0000-4000-8000-0000000000ef',
      workspaceRoot: '/workspace',
      agent: {
        quiesce: () => {
          calls.push('quiesce')

          return Promise.resolve(QUIESCED)
        },
        stop: () => {
          calls.push('agent.stop')

          return Promise.resolve({ exitCode: 0, signal: null, forced: false })
        },
      },
      snapshot: {
        capture:
          capture ??
          (() => {
            calls.push('capture')

            return Promise.resolve(CAPTURED)
          }),
      },
      registerSnapshot: () => {
        calls.push('registerSnapshot')

        return Promise.resolve()
      },
      acknowledge: () => {
        calls.push('acknowledge')

        return Promise.resolve()
      },
      markSuspended: () => {
        calls.push('markSuspended')

        return Promise.resolve()
      },
      releaseCompute: () => {
        calls.push('releaseCompute')

        return Promise.resolve()
      },
      sleep: () => Promise.resolve(),
      ...overrides,
    },
  }
}

describe('suspensionPlanFor — the only difference between the three causes', () => {
  it('records the reason as the snapshot boundary', () => {
    expect(suspensionPlanFor('pause').boundary).toBe('pause')
    expect(suspensionPlanFor('interruption').boundary).toBe('interruption')
    expect(suspensionPlanFor('stop').boundary).toBe('stop')
  })

  it('holds compute for a pause and releases it immediately for the other two', () => {
    expect(suspensionPlanFor('pause').computeRelease).toBe('on-idle-ceiling')
    expect(suspensionPlanFor('interruption').computeRelease).toBe('immediate')
    expect(suspensionPlanFor('stop').computeRelease).toBe('immediate')
  })

  it('keeps the agent alive on a pause and only on a pause', () => {
    expect(suspensionPlanFor('pause').stopsAgent).toBe(false)
    expect(suspensionPlanFor('interruption').stopsAgent).toBe(true)
    expect(suspensionPlanFor('stop').stopsAgent).toBe(true)
  })
})

describe('suspend', () => {
  it('acknowledges only after the snapshot is registered (FR-049)', async () => {
    const harness = harnessFor('pause')

    await suspend(harness.options)

    expect(harness.calls).toStrictEqual([
      'quiesce',
      'capture',
      'registerSnapshot',
      'acknowledge',
      'markSuspended',
    ])
    expect(harness.calls.indexOf('acknowledge')).toBeGreaterThan(
      harness.calls.indexOf('registerSnapshot'),
    )
  })

  it('reaches a turn boundary before it captures, so the snapshot is of settled work', async () => {
    const harness = harnessFor('pause')

    await suspend(harness.options)

    expect(harness.calls.indexOf('quiesce')).toBeLessThan(harness.calls.indexOf('capture'))
  })

  it('is one routine for all three causes', async () => {
    const results = await Promise.all(
      (['pause', 'interruption', 'stop'] as const).map(async (reason) => {
        const harness = harnessFor(reason)
        const result = await suspend(harness.options)

        return { reason, calls: harness.calls, result }
      }),
    )

    for (const { calls } of results) {
      // The same five steps, in the same order, every time.
      expect(calls.slice(0, 5)).toStrictEqual([
        'quiesce',
        'capture',
        'registerSnapshot',
        'acknowledge',
        'markSuspended',
      ])
    }

    expect(results.map(({ reason, result }) => [reason, result.computeReleased])).toStrictEqual([
      ['pause', false],
      ['interruption', true],
      ['stop', true],
    ])
  })

  it('leaves the agent process alive on a pause', async () => {
    const harness = harnessFor('pause')

    await suspend(harness.options)

    expect(harness.calls).not.toContain('agent.stop')
    expect(harness.calls).not.toContain('releaseCompute')
  })

  it('ends the agent and gives the compute back on an interruption', async () => {
    const harness = harnessFor('interruption')

    const result = await suspend(harness.options)

    expect(harness.calls).toContain('agent.stop')
    expect(harness.calls[harness.calls.length - 1]).toBe('releaseCompute')
    expect(result.plan.reason).toBe('interruption')
  })

  it('reports consumption as at the boundary, which is what the snapshot is registered against', async () => {
    const harness = harnessFor('stop')

    const result = await suspend(harness.options)

    expect(result.usage).toStrictEqual(QUIESCED.usage)
    expect(result.waitedForTurn).toBe(true)
    expect(result.snapshot).toStrictEqual(CAPTURED)
  })

  it('registers both state flags, because a snapshot missing either is not resumable (FR-050)', async () => {
    const registered: unknown[] = []
    const harness = harnessFor('pause', {
      registerSnapshot: (registration) => {
        registered.push(registration)

        return Promise.resolve()
      },
    })

    await suspend(harness.options)

    expect(registered[0]).toMatchObject({
      boundary: 'pause',
      s3Key: CAPTURED.s3Key,
      hasConversationState: true,
      hasWorktreeState: true,
      sessionId: harness.options.sessionId,
    })
  })

  it('records that nobody was told, when there was nobody to tell', async () => {
    // An interruption is not a request, so there is no command to acknowledge.
    const harness = harnessFor('interruption', { acknowledge: undefined })

    const result = await suspend(harness.options)

    expect(result.acknowledged).toBe(false)
    expect(harness.calls).not.toContain('acknowledge')
  })

  it('does not capture when no turn boundary was reached', async () => {
    const harness = harnessFor('pause', {
      agent: {
        quiesce: () =>
          Promise.reject(
            new AgentAdapterError('quiesce-timeout', 'no turn boundary reached within 4000ms'),
          ),
        stop: () => Promise.resolve({}),
      },
    })

    await expect(suspend(harness.options)).rejects.toBeInstanceOf(AgentAdapterError)
    expect(harness.calls).toStrictEqual([])
  })

  it('parks at the boundary when storage is unreachable, and retries only the write (FR-082)', async () => {
    let attempts = 0
    const harness = harnessFor(
      'pause',
      { parkBudget: { maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 4, factor: 2 } },
      () => {
        attempts += 1

        return attempts < 3
          ? Promise.reject(new Error('durable storage unreachable'))
          : Promise.resolve(CAPTURED)
      },
    )

    const result = await suspend(harness.options)

    expect(attempts).toBe(3)
    expect(result.parkedAttempts).toBe(2)
    // One quiesce, not three: the agent was held at the boundary it had already reached, so the
    // cost of parking was storage retries rather than re-run inference.
    expect(harness.calls.filter((call) => call === 'quiesce')).toHaveLength(1)
    expect(harness.calls).toStrictEqual([
      'quiesce',
      'registerSnapshot',
      'acknowledge',
      'markSuspended',
    ])
  })

  it('tells nobody the run is paused while it is still parked', async () => {
    const reports: number[] = []
    const harness = harnessFor(
      'pause',
      {
        parkBudget: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 4, factor: 2 },
        onParked: (report) => {
          reports.push(report.attempt)
          // Nothing has been acknowledged or released at any point during the park.
          expect(harness.calls).not.toContain('acknowledge')
          expect(harness.calls).not.toContain('releaseCompute')
        },
      },
      () => Promise.reject(new Error('bucket unreachable')),
    )

    await expect(suspend(harness.options)).rejects.toBeInstanceOf(SnapshotBoundaryUnpersistedError)

    expect(reports).toStrictEqual([1, 2])
    expect(harness.calls).toStrictEqual(['quiesce'])
  })

  it('fails naming the boundary it could not persist, with nothing acknowledged (FR-082)', async () => {
    const harness = harnessFor(
      'stop',
      { parkBudget: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1, factor: 2 } },
      () => Promise.reject(new Error('bucket unreachable')),
    )

    const failure = (await suspend(harness.options).catch(
      (error: unknown) => error,
    )) as SnapshotBoundaryUnpersistedError

    expect(failure).toBeInstanceOf(SnapshotBoundaryUnpersistedError)
    expect(failure.boundary).toBe('stop')
    expect(harness.calls).not.toContain('registerSnapshot')
    expect(harness.calls).not.toContain('acknowledge')
    expect(harness.calls).not.toContain('releaseCompute')
  })
})
