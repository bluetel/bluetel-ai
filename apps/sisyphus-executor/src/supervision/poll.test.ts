import { describe, expect, it } from 'vitest'

import { POLL_INTERVAL_MS } from './budget'
import type {
  CollectedCommand,
  CommandAcknowledgement,
  SupervisionHandlers,
  SupervisionTransport,
} from './poll'
import { createSupervisionPoller, inSequenceOrder } from './poll'

/**
 * T090. The assertions that carry the requirement:
 *
 * - commands are applied in `sequence` order, whatever order the pull returned them in;
 * - a `superseded` command is acknowledged and **never reaches a handler**;
 * - the interval is bounded by `./budget.ts`, so worst-case pause latency stays inside SC-003.
 */

const command = (overrides: Partial<CollectedCommand> & { id: string }): CollectedCommand => ({
  command: 'pause',
  sequence: 1,
  deliveryOutcome: 'pending',
  failureReason: null,
  ...overrides,
})

interface Recorder {
  readonly transport: SupervisionTransport
  readonly acknowledgements: CommandAcknowledgement[]
  readonly pulls: number[]
}

const recordingTransport = (batches: readonly (readonly CollectedCommand[])[]): Recorder => {
  const acknowledgements: CommandAcknowledgement[] = []
  const pulls: number[] = []
  let index = 0

  return {
    acknowledgements,
    pulls,
    transport: {
      pullPendingCommands: () => {
        const batch = batches[index] ?? []
        pulls.push(index)
        index += 1

        return Promise.resolve(batch)
      },
      acknowledgeCommand: (acknowledgement) => {
        acknowledgements.push(acknowledgement)

        return Promise.resolve()
      },
    },
  }
}

const recordingHandlers = (
  applied: string[],
  overrides: Partial<SupervisionHandlers> = {},
): SupervisionHandlers => ({
  onPause: () => {
    applied.push('pause')

    return Promise.resolve()
  },
  onStop: () => {
    applied.push('stop')

    return Promise.resolve()
  },
  onResume: () => {
    applied.push('resume')

    return Promise.resolve()
  },
  ...overrides,
})

describe('inSequenceOrder', () => {
  it('orders by sequence, not by arrival', () => {
    expect(
      inSequenceOrder([{ sequence: 9 }, { sequence: 2 }]).map((c) => c.sequence),
    ).toStrictEqual([2, 9])
  })
})

describe('the supervision poller', () => {
  it('applies in sequence order however the pull returned them', async () => {
    const applied: string[] = []
    const recorder = recordingTransport([
      [
        command({ id: 'c3', command: 'resume', sequence: 3 }),
        command({ id: 'c1', command: 'pause', sequence: 1 }),
        command({ id: 'c2', command: 'pause', sequence: 2 }),
      ],
    ])

    const poller = createSupervisionPoller({
      transport: recorder.transport,
      handlers: recordingHandlers(applied),
    })

    const result = await poller.cycle()

    expect(applied).toStrictEqual(['pause', 'pause', 'resume'])
    expect(result.handled.map((entry) => entry.commandId)).toStrictEqual(['c1', 'c2', 'c3'])
    expect(recorder.acknowledgements.map((entry) => entry.commandId)).toStrictEqual([
      'c1',
      'c2',
      'c3',
    ])
  })

  it('never applies a superseded command, and acknowledges it anyway', async () => {
    const applied: string[] = []
    const recorder = recordingTransport([
      [
        command({
          id: 'c1',
          command: 'pause',
          sequence: 1,
          deliveryOutcome: 'superseded',
          failureReason: 'overtaken by a stop',
        }),
        command({ id: 'c2', command: 'stop', sequence: 2 }),
      ],
    ])

    const poller = createSupervisionPoller({
      transport: recorder.transport,
      handlers: recordingHandlers(applied),
    })

    const result = await poller.cycle()

    // The pause never reached a handler. This is the assertion the requirement is made of.
    expect(applied).toStrictEqual(['stop'])
    expect(result.handled[0]).toMatchObject({
      commandId: 'c1',
      outcome: 'superseded',
      applied: false,
    })
    expect(recorder.acknowledgements[0]).toStrictEqual({
      commandId: 'c1',
      outcome: 'superseded',
      failureReason: 'overtaken by a stop',
    })
  })

  it('leaves a superseded command unqueued even when it is the only row', async () => {
    const applied: string[] = []
    const recorder = recordingTransport([
      [command({ id: 'c1', deliveryOutcome: 'superseded', failureReason: null })],
    ])

    await createSupervisionPoller({
      transport: recorder.transport,
      handlers: recordingHandlers(applied),
    }).cycle()

    expect(applied).toStrictEqual([])
    expect(recorder.acknowledgements).toHaveLength(1)
  })

  it('reports a handler failure as rejected and stops the batch', async () => {
    const applied: string[] = []
    const recorder = recordingTransport([
      [
        command({ id: 'c1', command: 'pause', sequence: 1 }),
        command({ id: 'c2', command: 'stop', sequence: 2 }),
      ],
    ])

    const poller = createSupervisionPoller({
      transport: recorder.transport,
      handlers: recordingHandlers(applied, {
        onPause: () => Promise.reject(new Error('no turn boundary reached within 4000ms')),
      }),
    })

    const result = await poller.cycle()

    expect(result.haltedEarly).toBe(true)
    expect(applied).toStrictEqual([])
    expect(recorder.acknowledgements).toStrictEqual([
      {
        commandId: 'c1',
        outcome: 'rejected',
        failureReason: 'no turn boundary reached within 4000ms',
      },
    ])
    // The stop is left pending rather than applied against a run whose state is now unknown.
    expect(result.handled.map((entry) => entry.commandId)).toStrictEqual(['c1'])
  })

  it('acknowledges a resume without a handler rather than failing on it', async () => {
    // Resume is the control plane's job — a fresh instance from the snapshot — not this executor's.
    const applied: string[] = []
    const recorder = recordingTransport([[command({ id: 'c1', command: 'resume' })]])

    const result = await createSupervisionPoller({
      transport: recorder.transport,
      handlers: {
        onPause: () => Promise.resolve(),
        onStop: () => Promise.resolve(),
      },
    }).cycle()

    expect(applied).toStrictEqual([])
    expect(result.handled[0]).toMatchObject({ outcome: 'acknowledged', applied: true })
  })

  it('polls on a bounded interval, defaulting to the SC-003 budget', async () => {
    const waits: number[] = []
    const recorder = recordingTransport([[], [], []])
    const poller = createSupervisionPoller({
      transport: recorder.transport,
      handlers: recordingHandlers([]),
      sleep: (milliseconds) => {
        waits.push(milliseconds)

        if (waits.length >= 3) {
          poller.stop()
        }

        return Promise.resolve()
      },
    })

    await poller.run()

    expect(waits).toStrictEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS, POLL_INTERVAL_MS])
    expect(poller.isRunning()).toBe(false)
  })

  it('keeps listening when a pull fails, because an unreachable API is a transient', async () => {
    const errors: unknown[] = []
    let pulls = 0
    const poller = createSupervisionPoller({
      transport: {
        pullPendingCommands: () => {
          pulls += 1

          return pulls === 1
            ? Promise.reject(new Error('machine surface unreachable'))
            : Promise.resolve([])
        },
        acknowledgeCommand: () => Promise.resolve(),
      },
      handlers: recordingHandlers([]),
      onCycleError: (error) => errors.push(error),
      sleep: () => {
        if (pulls >= 2) {
          poller.stop()
        }

        return Promise.resolve()
      },
    })

    await poller.run()

    expect(errors).toHaveLength(1)
    expect(pulls).toBeGreaterThanOrEqual(2)
  })

  it('stops between cycles rather than mid-batch', async () => {
    const recorder = recordingTransport([[command({ id: 'c1' })], [command({ id: 'c2' })]])
    const applied: string[] = []
    const poller = createSupervisionPoller({
      transport: recorder.transport,
      handlers: recordingHandlers(applied),
      sleep: () => {
        poller.stop()

        return Promise.resolve()
      },
    })

    await poller.run()

    expect(applied).toStrictEqual(['pause'])
    expect(recorder.acknowledgements).toHaveLength(1)
  })
})
