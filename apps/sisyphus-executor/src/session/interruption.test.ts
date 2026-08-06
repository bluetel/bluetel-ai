import { describe, expect, it } from 'vitest'

import type { AgentQuiescedState } from '../agent'

import type { InstanceMetadataReader, InterruptionNotice } from './interruption'
import {
  createQuietMetadataReader,
  DEFAULT_INTERRUPTION_POLL_MS,
  watchForInterruption,
} from './interruption'
import type { CapturedSnapshot, SuspendOptions } from './suspend'

/**
 * T100. The requirement is that an interruption goes through the **same** `suspend()` as a manual
 * pause (FR-054, R3), so the assertions here are about what the watch does to the suspension, not
 * about the suspension itself — `suspend.test.ts` owns that.
 *
 * The one that carries the requirement is the call order: `quiesce → capture → register →
 * mark → agent.stop → release`, observed through the same recorder `suspend.test.ts` uses. If this
 * module ever grew its own snapshot-and-park sequence, that order would come out different or not
 * at all.
 *
 * Nothing here goes near instance metadata. Spike S2 observed nothing about IMDS or a real
 * reclamation notice, so the reader is a fake and this file makes no claim about what a real one
 * would return.
 */

const QUIESCED: AgentQuiescedState = { usage: { turns: 4, spendUsd: 0.5 }, waitedForTurn: false }

const CAPTURED: CapturedSnapshot = {
  s3Key: 'snapshots/wf/interruption.tar.zst',
  sizeBytes: 2_048,
  hasConversationState: true,
  hasWorktreeState: true,
}

const NOTICE: InterruptionNotice = {
  reclaimAt: new Date('2026-08-05T09:02:00.000Z'),
  action: 'terminate',
}

interface Harness {
  readonly calls: string[]
  readonly suspension: Omit<SuspendOptions, 'reason'>
}

const harness = (): Harness => {
  const calls: string[] = []

  return {
    calls,
    suspension: {
      sessionId: '0199a1f4-0000-7000-8000-0000000000a1',
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
        capture: (request) => {
          calls.push(`capture:${request.boundary}`)

          return Promise.resolve(CAPTURED)
        },
      },
      registerSnapshot: (registration) => {
        calls.push(`register:${registration.boundary}`)

        return Promise.resolve()
      },
      markSuspended: (plan) => {
        calls.push(`mark:${plan.reason}`)

        return Promise.resolve()
      },
      releaseCompute: () => {
        calls.push('release')

        return Promise.resolve()
      },
    },
  }
}

/** A reader that answers with a scripted sequence, one entry per poll. */
const readerOf = (
  script: readonly (InterruptionNotice | null | Error)[],
): InstanceMetadataReader => {
  let index = 0

  return {
    readInterruptionNotice: () => {
      const next = script[index] ?? null

      index += 1

      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
    },
  }
}

describe('createQuietMetadataReader', () => {
  it('reports no notice, so a run without one is not a special case', async () => {
    await expect(createQuietMetadataReader().readInterruptionNotice()).resolves.toBeNull()
  })
})

describe('watchForInterruption', () => {
  it('routes a notice through the same suspend() a manual pause uses (FR-054, R3)', async () => {
    const { calls, suspension } = harness()

    const result = await watchForInterruption({
      metadata: readerOf([null, null, NOTICE]),
      suspension,
      sleep: () => Promise.resolve(),
    })

    expect(result.stoppedBecause).toBe('interrupted')
    expect(result.notice).toStrictEqual(NOTICE)
    expect(result.polls).toBe(3)
    // The order suspend() imposes, observed from outside it. A second interruption path written
    // here would not produce this sequence.
    expect(calls).toStrictEqual([
      'quiesce',
      'capture:interruption',
      'register:interruption',
      'mark:interruption',
      'agent.stop',
      'release',
    ])
  })

  it('records the interruption reason and releases compute immediately', async () => {
    const { suspension } = harness()

    const result = await watchForInterruption({
      metadata: readerOf([NOTICE]),
      suspension,
      sleep: () => Promise.resolve(),
    })

    expect(result.suspension?.plan.reason).toBe('interruption')
    expect(result.suspension?.plan.computeRelease).toBe('immediate')
    expect(result.suspension?.computeReleased).toBe(true)
    // Nobody asked for an interruption, so there is no command to acknowledge.
    expect(result.suspension?.acknowledged).toBe(false)
  })

  it('reports the notice before the suspension starts, so the panel is not last to know', async () => {
    const { calls, suspension } = harness()
    const seen: InterruptionNotice[] = []

    await watchForInterruption({
      metadata: readerOf([NOTICE]),
      suspension,
      sleep: () => Promise.resolve(),
      onNotice: (notice) => {
        seen.push(notice)
        calls.push('notice')
      },
    })

    expect(seen).toStrictEqual([NOTICE])
    expect(calls[0]).toBe('notice')
  })

  it('stops without suspending when the run ends first — the ordinary outcome', async () => {
    const { calls, suspension } = harness()
    const controller = new AbortController()

    const watch = watchForInterruption({
      metadata: readerOf([null, null]),
      suspension,
      signal: controller.signal,
      sleep: () => {
        controller.abort()

        return Promise.resolve()
      },
    })

    const result = await watch

    expect(result.stoppedBecause).toBe('aborted')
    expect(result.notice).toBeNull()
    expect(result.suspension).toBeNull()
    expect(calls).toStrictEqual([])
  })

  it('never starts even one poll once the signal is already aborted', async () => {
    const { suspension } = harness()

    const result = await watchForInterruption({
      metadata: readerOf([NOTICE]),
      suspension,
      signal: AbortSignal.abort(),
      sleep: () => Promise.resolve(),
    })

    expect(result.polls).toBe(0)
    expect(result.suspension).toBeNull()
  })

  it('treats an unreadable metadata service as unknown, never as “no notice”', async () => {
    const { suspension } = harness()
    const failures: number[] = []

    const result = await watchForInterruption({
      metadata: readerOf([new Error('connect ECONNREFUSED 169.254.169.254:80'), NOTICE]),
      suspension,
      sleep: () => Promise.resolve(),
      onReadFailure: (_error, consecutive) => failures.push(consecutive),
    })

    expect(failures).toStrictEqual([1])
    expect(result.readFailures).toBe(1)
    // The failed read did not end the watch, and the notice on the next poll was still acted on.
    expect(result.stoppedBecause).toBe('interrupted')
  })

  it('polls on a cadence that is a rounding error against a notice period', () => {
    expect(DEFAULT_INTERRUPTION_POLL_MS).toBe(5_000)
  })

  it('waits the configured interval between polls', async () => {
    const { suspension } = harness()
    const waits: number[] = []

    await watchForInterruption({
      metadata: readerOf([null, null, NOTICE]),
      suspension,
      pollIntervalMs: 250,
      sleep: (milliseconds) => {
        waits.push(milliseconds)

        return Promise.resolve()
      },
    })

    expect(waits).toStrictEqual([250, 250])
  })
})
