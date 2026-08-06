import { describe, expect, it } from 'vitest'

import type { AgentAdapter, AgentFrame, AgentProcessSpecFactory, AgentTurnDelivery } from '../agent'
import {
  AgentAdapterError,
  createCliStreamAdapter,
  INJECTION_MARKER,
  resolveTsxBinary,
  stubAgentEntry,
} from '../agent'

import type {
  CollectedCorrection,
  CorrectionAcknowledgement,
  CorrectionSender,
  CorrectionTransport,
} from './corrections'
import {
  createCorrectionDeliverer,
  inSequenceOrder,
  UNCONFIRMED_DELIVERY_REASON,
} from './corrections'

/**
 * T093, the executor half.
 *
 * The first group uses a fake sender, because the rules being asserted are about *this loop* —
 * ordering, serialisation, and what an unconfirmed delivery is reported as. The last group drives
 * the loop through the real `createCliStreamAdapter` against the stub agent process, over real
 * pipes, so "a correction reaches a live agent without a restart" is exercised rather than assumed.
 *
 * **No paid inference is involved anywhere in this file.** The stub speaks the NDJSON frame
 * vocabulary taken from the shipped CLI's own strings (spike S1); it is a faithful subset, not the
 * CLI, and nothing here asserts anything about the real CLI's scheduling — which S1 recorded as not
 * observed.
 */

const correction = (id: string, sequence: number, body: string): CollectedCorrection => ({
  id,
  sequence,
  body,
})

interface Recorder {
  readonly transport: CorrectionTransport
  readonly acknowledgements: CorrectionAcknowledgement[]
}

const recordingTransport = (pending: readonly CollectedCorrection[]): Recorder => {
  const acknowledgements: CorrectionAcknowledgement[] = []
  let drained = false

  return {
    acknowledgements,
    transport: {
      pullPendingCorrections: () => {
        const batch = drained ? [] : pending
        drained = true

        return Promise.resolve(batch)
      },
      acknowledgeCorrection: (acknowledgement) => {
        acknowledgements.push(acknowledgement)

        return Promise.resolve()
      },
    },
  }
}

const senderThat = (
  deliver: (body: string) => Promise<AgentTurnDelivery>,
  sent: string[],
): CorrectionSender => ({
  sendTurn: (body) => {
    sent.push(body)

    return deliver(body)
  },
})

describe('inSequenceOrder', () => {
  it('is submission order and nothing else', () => {
    const ordered = inSequenceOrder([correction('b', 2, 'second'), correction('a', 1, 'first')])

    expect(ordered.map((entry) => entry.body)).toStrictEqual(['first', 'second'])
  })
})

describe('the correction deliverer', () => {
  it('delivers in submission order and acknowledges each one', async () => {
    const sent: string[] = []
    const recorder = recordingTransport([
      correction('c2', 2, 'second'),
      correction('c1', 1, 'first'),
      correction('c3', 3, 'third'),
    ])

    const result = await createCorrectionDeliverer({
      transport: recorder.transport,
      agent: senderThat(() => Promise.resolve({ acknowledged: true, latencyMs: 3 }), sent),
    }).cycle()

    expect(sent).toStrictEqual(['first', 'second', 'third'])
    expect(recorder.acknowledgements.map((entry) => entry.correctionId)).toStrictEqual([
      'c1',
      'c2',
      'c3',
    ])
    expect(result.delivered.every((entry) => entry.outcome === 'delivered')).toBe(true)
  })

  it('never has two deliveries in flight', async () => {
    const sent: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const recorder = recordingTransport([
      correction('c1', 1, 'first'),
      correction('c2', 2, 'second'),
    ])

    await createCorrectionDeliverer({
      transport: recorder.transport,
      agent: senderThat(async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1

        return { acknowledged: true, latencyMs: 5 }
      }, sent),
    }).cycle()

    expect(maxInFlight).toBe(1)
  })

  it('reports an unconfirmed delivery as failed rather than rounding it up to delivered', async () => {
    // The write succeeded; nothing echoed the turn back. Calling that "delivered" is the specific
    // lie SC-004 forbids, so it is a failure with a reason that says exactly what is unknown.
    const sent: string[] = []
    const recorder = recordingTransport([correction('c1', 1, 'unconfirmed')])

    const result = await createCorrectionDeliverer({
      transport: recorder.transport,
      agent: senderThat(() => Promise.resolve({ acknowledged: false, latencyMs: 5_000 }), sent),
    }).cycle()

    expect(result.delivered[0]).toMatchObject({
      outcome: 'failed',
      acknowledgedByAgent: false,
      latencyMs: 5_000,
      failureReason: UNCONFIRMED_DELIVERY_REASON,
    })
    expect(recorder.acknowledgements[0]).toStrictEqual({
      correctionId: 'c1',
      outcome: 'failed',
      failureReason: UNCONFIRMED_DELIVERY_REASON,
    })
  })

  it('acknowledges a refused write as failed, carrying the adapter’s own reason', async () => {
    const sent: string[] = []
    const recorder = recordingTransport([correction('c1', 1, 'refused')])

    const result = await createCorrectionDeliverer({
      transport: recorder.transport,
      agent: senderThat(
        () =>
          Promise.reject(
            new AgentAdapterError(
              'delivery-failed',
              'the agent process is not accepting input; the turn was not delivered',
            ),
          ),
        sent,
      ),
    }).cycle()

    expect(result.delivered[0]?.failureReason).toContain('not accepting input')
    expect(recorder.acknowledgements[0]?.outcome).toBe('failed')
  })

  it('never drops a correction silently — every collected row is acknowledged', async () => {
    const sent: string[] = []
    const recorder = recordingTransport([correction('c1', 1, 'one')])

    await createCorrectionDeliverer({
      transport: recorder.transport,
      agent: senderThat(() => Promise.reject(new Error('gone')), sent),
    }).cycle()

    expect(recorder.acknowledgements).toHaveLength(1)
  })

  it('stops the batch after a failure, so guidance cannot land out of order', async () => {
    const sent: string[] = []
    const recorder = recordingTransport([
      correction('c1', 1, 'first'),
      correction('c2', 2, 'second'),
    ])

    const result = await createCorrectionDeliverer({
      transport: recorder.transport,
      agent: senderThat(() => Promise.reject(new Error('gone')), sent),
    }).cycle()

    expect(result.haltedEarly).toBe(true)
    expect(sent).toStrictEqual(['first'])
    expect(recorder.acknowledgements.map((entry) => entry.correctionId)).toStrictEqual(['c1'])
  })

  it('does nothing at all when the queue is empty', async () => {
    const sent: string[] = []
    const recorder = recordingTransport([])

    const result = await createCorrectionDeliverer({
      transport: recorder.transport,
      agent: senderThat(() => Promise.resolve({ acknowledged: true, latencyMs: 0 }), sent),
    }).cycle()

    expect(result).toMatchObject({ collected: 0, haltedEarly: false })
    expect(sent).toStrictEqual([])
  })
})

/**
 * The loop against a genuine child process. Same adapter the executor uses in production; only the
 * process spec differs.
 */
const SESSION_ID = '9f1d1b3e-0000-4000-8000-0000000000cd'

const stubProcessSpec = (): AgentProcessSpecFactory => () => ({
  command: resolveTsxBinary(),
  args: [
    stubAgentEntry(),
    JSON.stringify({ sessionId: SESSION_ID, chunkCount: 12, chunkDelayMs: 30 }),
  ],
  env: {},
})

const drain = (adapter: AgentAdapter, frames: AgentFrame[]): Promise<void> =>
  (async () => {
    for await (const frame of adapter.output) {
      frames.push(frame)
    }
  })()

describe('the correction deliverer against the stub agent process', () => {
  it('delivers two corrections into one live session, in order, with no restart', async () => {
    const frames: AgentFrame[] = []
    const adapter = createCliStreamAdapter({
      processSpec: stubProcessSpec(),
      sendTurnTimeoutMs: 10_000,
    })
    const consumed = drain(adapter, frames)

    try {
      await adapter.start({
        sessionId: SESSION_ID,
        cwd: process.cwd(),
        model: 'claude-sonnet-4-5',
        prompt: 'first task',
      })

      const recorder = recordingTransport([
        correction('c2', 2, 'second correction'),
        correction('c1', 1, 'first correction'),
      ])

      const result = await createCorrectionDeliverer({
        transport: recorder.transport,
        agent: adapter,
        sendTurnTimeoutMs: 10_000,
      }).cycle()

      expect(result.delivered.map((entry) => [entry.sequence, entry.outcome])).toStrictEqual([
        [1, 'delivered'],
        [2, 'delivered'],
      ])
      expect(result.delivered.every((entry) => entry.acknowledgedByAgent)).toBe(true)
      expect(recorder.acknowledgements.map((entry) => entry.outcome)).toStrictEqual([
        'delivered',
        'delivered',
      ])

      // Both turns reached the same live process: the acknowledgement is the agent's own replay,
      // and the injection marker is the stub reporting that it saw the turn mid-response.
      const replays = frames.filter(
        (frame) => frame.type === 'user' && frame.text.includes('correction'),
      )
      expect(replays.map((frame) => (frame.type === 'user' ? frame.text : ''))).toStrictEqual([
        'first correction',
        'second correction',
      ])
      expect(
        frames.some((frame) => frame.type === 'assistant' && frame.text.includes(INJECTION_MARKER)),
      ).toBe(true)
    } finally {
      await adapter.stop({ force: true, timeoutMs: 2_000 })
      await consumed
    }
  }, 30_000)

  it('fails visibly when the session has ended, rather than dropping the correction', async () => {
    const frames: AgentFrame[] = []
    const adapter = createCliStreamAdapter({ processSpec: stubProcessSpec() })
    const consumed = drain(adapter, frames)

    await adapter.start({
      sessionId: SESSION_ID,
      cwd: process.cwd(),
      model: 'claude-sonnet-4-5',
      prompt: 'first task',
    })
    await adapter.stop({ force: true, timeoutMs: 2_000 })
    await consumed

    const recorder = recordingTransport([correction('c1', 1, 'too late')])
    const result = await createCorrectionDeliverer({
      transport: recorder.transport,
      agent: adapter,
    }).cycle()

    expect(result.delivered[0]?.outcome).toBe('failed')
    expect(result.delivered[0]?.failureReason).toContain('session has ended')
    expect(recorder.acknowledgements).toStrictEqual([
      {
        correctionId: 'c1',
        outcome: 'failed',
        failureReason: 'the agent session has ended',
      },
    ])
  }, 30_000)
})
