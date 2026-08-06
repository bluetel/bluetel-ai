import { describe, expect, it } from 'vitest'

import type { ParkBudget, ParkReport } from './park'
import {
  DEFAULT_PARK_BUDGET,
  parkAndRetry,
  parkDelayMs,
  SnapshotBoundaryUnpersistedError,
} from './park'

/**
 * T092. Three things carry the requirement:
 *
 * - the operation is retried rather than the run advancing or dying (FR-082);
 * - every attempt is **reported**, so the panel can say "waiting on storage" instead of showing a
 *   pause that looks stalled;
 * - exhaustion fails **naming the boundary it could not persist**, because "your work is gone" and
 *   "the pause boundary is on an instance we are about to destroy" are different messages.
 */

const budget: ParkBudget = {
  maxAttempts: 4,
  initialDelayMs: 10,
  maxDelayMs: 40,
  factor: 2,
}

const immediately = (): Promise<void> => Promise.resolve()

describe('parkDelayMs', () => {
  it('backs off exponentially and then caps', () => {
    expect([1, 2, 3, 4, 5].map((attempt) => parkDelayMs(attempt, budget))).toStrictEqual([
      10, 20, 40, 40, 40,
    ])
  })

  it('caps the shipped default at half a minute', () => {
    expect(parkDelayMs(99, DEFAULT_PARK_BUDGET)).toBe(DEFAULT_PARK_BUDGET.maxDelayMs)
  })
})

describe('parkAndRetry', () => {
  it('returns the first success without waiting at all', async () => {
    const waits: number[] = []
    const result = await parkAndRetry({
      boundary: 'pause',
      budget,
      sleep: (ms) => {
        waits.push(ms)

        return immediately()
      },
      operation: () => Promise.resolve('written'),
    })

    expect(result).toBe('written')
    expect(waits).toStrictEqual([])
  })

  it('holds at the boundary and retries the storage write, not the work', async () => {
    // The operation is the only thing called. Nothing here can re-run a turn, because nothing here
    // knows about the agent — which is the structural version of "parking costs retries, not
    // inference".
    let attempts = 0
    const waits: number[] = []

    const result = await parkAndRetry({
      boundary: 'pause',
      budget,
      sleep: (ms) => {
        waits.push(ms)

        return immediately()
      },
      operation: () => {
        attempts += 1

        return attempts < 3
          ? Promise.reject(new Error('durable storage unreachable'))
          : Promise.resolve({ s3Key: 'snapshots/x.tar.zst' })
      },
    })

    expect(result).toStrictEqual({ s3Key: 'snapshots/x.tar.zst' })
    expect(attempts).toBe(3)
    expect(waits).toStrictEqual([10, 20])
  })

  it('reports every parked attempt, so the panel is never left showing a stalled pause', async () => {
    const reports: ParkReport[] = []
    let attempts = 0

    await parkAndRetry({
      boundary: 'interruption',
      budget,
      sleep: immediately,
      onParked: (report) => reports.push(report),
      operation: () => {
        attempts += 1

        return attempts < 3 ? Promise.reject(new Error('connection refused')) : Promise.resolve(1)
      },
    })

    expect(reports).toHaveLength(2)
    expect(reports[0]).toMatchObject({
      attempt: 1,
      maxAttempts: 4,
      boundary: 'interruption',
      reason: 'connection refused',
      nextDelayMs: 10,
    })
  })

  it('fails naming the boundary it could not persist (FR-082)', async () => {
    const failure = await parkAndRetry({
      boundary: 'pause',
      budget,
      sleep: immediately,
      operation: () => Promise.reject(new Error('bucket unreachable')),
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SnapshotBoundaryUnpersistedError)
    const named = failure as SnapshotBoundaryUnpersistedError
    expect(named.boundary).toBe('pause')
    expect(named.attempts).toBe(4)
    expect(named.message).toContain('pause snapshot boundary could not be persisted')
    expect(named.message).toContain('only on this instance')
    expect(named.cause).toBeInstanceOf(Error)
  })

  it('exposes the boundary as a field, not only inside a message', async () => {
    // A caller has to report the boundary as data. Scraping it out of a string is not reporting it.
    const failure = (await parkAndRetry({
      boundary: 'stop',
      budget: { ...budget, maxAttempts: 1 },
      sleep: immediately,
      operation: () => Promise.reject(new Error('nope')),
    }).catch((error: unknown) => error)) as SnapshotBoundaryUnpersistedError

    expect(failure.boundary).toBe('stop')
    expect(failure.attempts).toBe(1)
  })

  it('does not wait after the final attempt', async () => {
    const waits: number[] = []

    await parkAndRetry({
      boundary: 'pause',
      budget: { ...budget, maxAttempts: 2 },
      sleep: (ms) => {
        waits.push(ms)

        return immediately()
      },
      operation: () => Promise.reject(new Error('nope')),
    }).catch(() => undefined)

    expect(waits).toStrictEqual([10])
  })

  it('ships a bounded default rather than retrying forever', async () => {
    // An unbounded retry on a spot instance under a reclamation notice is a run that never reports
    // anything before the machine disappears.
    expect(DEFAULT_PARK_BUDGET.maxAttempts).toBeGreaterThan(1)
    expect(Number.isFinite(DEFAULT_PARK_BUDGET.maxAttempts)).toBe(true)
    await expect(Promise.resolve(DEFAULT_PARK_BUDGET.factor)).resolves.toBeGreaterThan(1)
  })
})
