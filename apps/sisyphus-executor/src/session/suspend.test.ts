import { afterEach, describe, expect, it, vi } from 'vitest'

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

  it('leaves a pause’s compute to the control plane and releases the other two here', () => {
    // 003/FR-039. `on-instance-stop` is not "hold this for ever" and is not "release it": it is
    // somebody else, from outside, stopping the instance with its disk retained. The executor
    // cannot do that itself — the launch sets `InstanceInitiatedShutdownBehavior: 'terminate'`, so
    // an executor that shut itself down would destroy the disk the pause exists to keep.
    expect(suspensionPlanFor('pause').computeRelease).toBe('on-instance-stop')
    expect(suspensionPlanFor('interruption').computeRelease).toBe('immediate')
    expect(suspensionPlanFor('stop').computeRelease).toBe('immediate')
  })

  it('ends the agent on every cause, including a pause (003/FR-039)', () => {
    // False for a pause under `002/FR-049`, when a pause held the process alive on a running
    // instance. Now the instance is about to be frozen, and an agent still writing to the working
    // tree after the snapshot of it was taken would leave the two disagreeing — silently, and
    // unrecoverably on the FR-043 path where the snapshot is all that survives.
    expect(suspensionPlanFor('pause').stopsAgent).toBe(true)
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
      // Last, and last on every cause since 003/FR-039: the agent is ended only once everything
      // that had to be captured and told has been.
      'agent.stop',
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

  /**
   * 003/T060, FR-030, R3. The rotation flush is the difference between a seat that resumes and one
   * needing an administrator to log in again, so the assertions here are about *when* it runs and
   * about it running for **every** cause — the second of which is only true because `suspend()` is
   * the single routine all three reach.
   */
  describe('the credential rotation flush (003/FR-030)', () => {
    it('writes a rotation through for a pause, an interruption and a stop alike', async () => {
      for (const reason of ['pause', 'interruption', 'stop'] as const) {
        const harness = harnessFor(reason, {
          flushCredentialRotation: () => Promise.resolve('reported'),
        })

        // Substituted so the recorded order includes it; the harness's own
        // callbacks push their names the same way.
        const options = {
          ...harness.options,
          flushCredentialRotation: () => {
            harness.calls.push('flushCredentialRotation')

            return Promise.resolve('reported')
          },
        }

        await suspend(options)

        expect(harness.calls).toContain('flushCredentialRotation')
      }
    })

    it('flushes after the turn boundary and before anything that can park', async () => {
      const harness = harnessFor('pause')
      const options = {
        ...harness.options,
        flushCredentialRotation: () => {
          harness.calls.push('flushCredentialRotation')

          return Promise.resolve('reported')
        },
      }

      await suspend(options)

      // After `quiesce`, because only then is the agent no longer writing the file. Before
      // `capture`, because the capture can park for minutes against unreachable storage and a
      // rotation must not be waiting behind it when the instance goes away.
      expect(harness.calls.slice(0, 3)).toStrictEqual([
        'quiesce',
        'flushCredentialRotation',
        'capture',
      ])
    })

    it('does not flush when no turn boundary was reached', async () => {
      const harness = harnessFor('pause', {
        agent: {
          quiesce: () => Promise.reject(new AgentAdapterError('quiesce-timeout', 'still working')),
          stop: () => Promise.resolve({}),
        },
        flushCredentialRotation: () => {
          harness.calls.push('flushCredentialRotation')

          return Promise.resolve('reported')
        },
      })

      await expect(suspend(harness.options)).rejects.toThrow()

      // Nothing is lost by this: the suspension was refused, so the run carries on with its watcher
      // still armed, and the next suspension flushes what this one did not.
      expect(harness.calls).not.toContain('flushCredentialRotation')
    })

    it('does not fail the suspension when the flush fails', async () => {
      const harness = harnessFor('stop', {
        flushCredentialRotation: () => Promise.reject(new Error('machine surface unreachable')),
      })

      // Losing a rotation is bad. Losing the snapshot to it would be worse: the snapshot is the
      // work, and the seat is recoverable by an administrator while the work is not.
      const result = await suspend(harness.options)

      expect(result.snapshot).toStrictEqual(CAPTURED)
      expect(harness.calls).toContain('registerSnapshot')
    })

    it('suspends normally when no watcher was armed', async () => {
      const harness = harnessFor('pause')

      await expect(suspend(harness.options)).resolves.toMatchObject({ acknowledged: true })
    })
  })

  /**
   * **003/T098, FR-039 — the hold-alive path is gone, and the rotation flush is still ahead of it.**
   *
   * Both halves matter and the order of the recorded calls carries both: the agent is ended, so
   * nothing writes to the working tree after the snapshot was captured; and `flushCredentialRotation`
   * ran before the capture, so a rotation observed moments before the instance is frozen was
   * written through rather than left in a debounce window on a disk about to stop being touched.
   * A flush moved below the agent stop would be a flush of a file the agent may never have finished
   * writing.
   */
  it('ends the agent on a pause and releases no compute itself (003/FR-039)', async () => {
    const flushed: string[] = []
    const harness = harnessFor('pause', {
      flushCredentialRotation: () => {
        flushed.push('flush')

        return Promise.resolve()
      },
    })

    const result = await suspend(harness.options)

    expect(harness.calls).toContain('agent.stop')
    // The control plane stops the instance, from outside, off the acknowledged pause. Nothing here
    // hands compute back, and `computeReleased` says so.
    expect(harness.calls).not.toContain('releaseCompute')
    expect(result.computeReleased).toBe(false)
    expect(result.plan.computeRelease).toBe('on-instance-stop')

    // The T060 flush, still ahead of the capture and therefore ahead of everything below it.
    expect(flushed).toStrictEqual(['flush'])
    expect(harness.calls.indexOf('quiesce')).toBeLessThan(harness.calls.indexOf('capture'))
    expect(harness.calls.indexOf('capture')).toBeLessThan(harness.calls.indexOf('agent.stop'))
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
      'agent.stop',
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

/**
 * **The budget terms, as bounds rather than as declarations (T185, FR-205, SC-003).**
 *
 * `supervision/budget.ts` gives the quiesce, the capture and the registration a share of SC-003's
 * ten seconds each. These assert that exceeding one *does* something, and that what it does is the
 * thing the requirement asks for — which differs per step, and is the whole design.
 */
describe('the SC-003 terms this routine enforces', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const hang = async (): Promise<never> => new Promise<never>(() => undefined)

  it('records when the suspension began, which is what the idle ceiling counts from', async () => {
    const at = new Date('2026-08-05T12:00:00.000Z')
    const harness = harnessFor('pause', { now: () => at })

    expect((await suspend(harness.options)).suspendedAt).toStrictEqual(at)
  })

  it('rejects rather than snapshotting mid-turn when the quiesce term is blown', async () => {
    vi.useFakeTimers()

    const harness = harnessFor('pause', {
      quiesceTimeoutMs: 50,
      agent: { quiesce: hang, stop: hang },
    })
    const pausing = suspend(harness.options)
    const settled = expect(pausing).rejects.toThrow(/turn boundary/)

    await vi.advanceTimersByTimeAsync(50)
    await settled

    // Nothing below step 1 ran, so nothing was captured and nobody was told a pause had happened.
    expect(harness.calls).toStrictEqual([])
  })

  it('bounds the quiesce even when the adapter ignores the timeout it was handed', async () => {
    // Passing a number to a port is a request. An adapter that ignores it — a fake, a future
    // adapter, a bug — would otherwise leave the *largest* term of the budget unenforced, which is
    // exactly the shape FR-205 forbids.
    vi.useFakeTimers()

    let handed: number | undefined
    const harness = harnessFor('pause', {
      quiesceTimeoutMs: 50,
      agent: {
        quiesce: async (options) => {
          handed = options?.timeoutMs
          return hang()
        },
        stop: hang,
      },
    })
    const pausing = suspend(harness.options)
    const settled = expect(pausing).rejects.toThrow(/50ms budget/)

    await vi.advanceTimersByTimeAsync(50)
    await settled

    expect(handed).toBe(50)
  })

  it('parks and retries a capture that blew its term, rather than failing the run', async () => {
    // FR-082's case, reached by a deadline rather than by a refusal: the store is answering, just
    // not inside the first attempt's share of the ten seconds.
    vi.useFakeTimers()

    const reports: string[] = []
    let attempts = 0
    const harness = harnessFor(
      'pause',
      {
        snapshotCaptureBudgetMs: 50,
        snapshotRetryBudgetMs: 10_000,
        parkBudget: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1, factor: 2 },
        onParked: (report) => {
          reports.push(report.reason)
        },
      },
      async () => {
        attempts += 1

        if (attempts === 1) {
          return hang()
        }

        return CAPTURED
      },
    )

    const pausing = suspend(harness.options)
    await vi.advanceTimersByTimeAsync(1_000)

    // The retry is given room, so a large working tree is not condemned by a deadline that is
    // already missed. The pause completes — late, and visibly so.
    await expect(pausing).resolves.toMatchObject({ snapshot: CAPTURED, parkedAttempts: 1 })
    expect(reports[0]).toMatch(/50ms budget/)
  })

  it('fails the pause when registration blows its term, so nothing unregistered is acknowledged', async () => {
    // FR-049's ordering, enforced by the deadline: a snapshot the platform cannot confirm it
    // registered must never be reported to a person as a pause they can resume from.
    vi.useFakeTimers()

    const harness = harnessFor('pause', {
      snapshotRegisterBudgetMs: 50,
      registerSnapshot: hang,
    })
    const pausing = suspend(harness.options)
    const settled = expect(pausing).rejects.toThrow(/registering the pause snapshot/)

    await vi.advanceTimersByTimeAsync(50)
    await settled

    expect(harness.calls).not.toContain('acknowledge')
  })
})
