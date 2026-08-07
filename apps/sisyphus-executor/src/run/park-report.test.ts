import { describe, expect, it } from 'vitest'

import type { KnownSecret } from '../output'
import type { SnapshotParkReport } from '../report'
import type { ParkReport } from '../session'
import { parkAndRetry, SnapshotBoundaryUnpersistedError } from '../session'

import { createParkReporter, parkLogLine } from './park-report'

/**
 * Reporting a park to the platform (T184, FR-082).
 *
 * The requirement under test is not "a callback was invoked" — that was true before this module
 * existed and the panel still could not tell a parked run from a stalled one. It is that a park
 * reaches the machine surface **carrying its attempt count**, that the retry loop is never held up
 * or brought down by the reporting, and that a storage error quoting a presigned URL does not
 * carry a credential onto the timeline.
 */

const park = (overrides: Partial<ParkReport> = {}): ParkReport => ({
  attempt: 1,
  maxAttempts: 8,
  boundary: 'pause',
  reason: 'the snapshot bucket is unreachable',
  nextDelayMs: 1000,
  ...overrides,
})

interface Surface {
  readonly reports: SnapshotParkReport[]
  readonly client: { readonly reportSnapshotPark: (report: SnapshotParkReport) => Promise<void> }
  reject: boolean
}

const surface = (): Surface => {
  const reports: SnapshotParkReport[] = []
  const state = { reject: false }

  return {
    reports,
    get reject() {
      return state.reject
    },
    set reject(value: boolean) {
      state.reject = value
    },
    client: {
      reportSnapshotPark: async (report) => {
        if (state.reject) {
          return Promise.reject(new Error('the machine surface is unreachable'))
        }

        reports.push(report)

        return Promise.resolve()
      },
    },
  }
}

/** Let the microtask queue drain, since the reporter dispatches without awaiting. */
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

describe('parkLogLine', () => {
  it('names the boundary, the attempt out of the budget, and when the next try is', () => {
    expect(parkLogLine(park({ attempt: 3, maxAttempts: 8, nextDelayMs: 4000 }))).toBe(
      '[suspend] storage is unreachable; holding at the pause boundary and retrying ' +
        '(attempt 3 of 8, next in 4000ms): the snapshot bucket is unreachable\n',
    )
  })
})

describe('createParkReporter', () => {
  it('reports the park to the machine surface with its attempt count (FR-082)', async () => {
    const world = surface()
    const lines: string[] = []
    const reporter = createParkReporter({
      client: world.client,
      log: async (line) => {
        lines.push(line)

        return Promise.resolve()
      },
    })

    reporter(park({ attempt: 2, maxAttempts: 8, nextDelayMs: 2000 }))
    await settle()

    expect(world.reports).toStrictEqual([
      {
        boundary: 'pause',
        attempt: 2,
        maxAttempts: 8,
        nextDelayMs: 2000,
        detail: 'the snapshot bucket is unreachable',
      },
    ])
    // Still logged as well. The operator watching output should not have to go and find a card.
    expect(lines).toHaveLength(1)
  })

  it('redacts a credential quoted by the storage client (FR-072)', async () => {
    const world = surface()
    const secret: KnownSecret = { name: 'AWS_SESSION_TOKEN', value: 'FwoGZXIvYXdzEJr' }
    const reporter = createParkReporter({
      client: world.client,
      log: async () => Promise.resolve(),
      secrets: [secret],
    })

    reporter(park({ reason: 'PUT failed: X-Amz-Security-Token=FwoGZXIvYXdzEJr' }))
    await settle()

    expect(world.reports).toHaveLength(1)
    expect(world.reports[0].detail).not.toContain('FwoGZXIvYXdzEJr')
  })

  it('never rejects out of the retry loop — a lost report must not cost a snapshot', async () => {
    const world = surface()
    world.reject = true

    const failures: string[] = []
    const reporter = createParkReporter({
      client: world.client,
      log: async () => Promise.reject(new Error('the segment writer is unreachable')),
      onReportingFailure: (_error, detail) => {
        failures.push(detail)
      },
    })

    // Both halves of the reporter are failing, and the hook still returns normally: it is called
    // between an attempt failing and the backoff wait, holding a quiesced agent.
    expect(() => {
      reporter(park({ attempt: 4 }))
    }).not.toThrow()
    await settle()

    expect(failures).toStrictEqual([
      'logging a park',
      'reporting a park at the pause boundary (attempt 4)',
    ])
  })

  it('reports every attempt when wired to the real park loop, in order', async () => {
    const world = surface()
    const reporter = createParkReporter({
      client: world.client,
      log: async () => Promise.resolve(),
    })

    await expect(
      parkAndRetry({
        boundary: 'interruption',
        budget: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0, factor: 1 },
        sleep: async () => Promise.resolve(),
        onParked: reporter,
        operation: () => Promise.reject(new Error('storage is gone')),
      }),
    ).rejects.toBeInstanceOf(SnapshotBoundaryUnpersistedError)
    await settle()

    // Two reports, not three: the final attempt exhausts the budget and throws rather than parking
    // again, and it is `reportTerminal` that names the boundary it could not persist.
    expect(world.reports.map((report) => report.attempt)).toStrictEqual([1, 2])
    expect(world.reports.every((report) => report.boundary === 'interruption')).toBe(true)
  })
})
