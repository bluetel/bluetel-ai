import { describe, expect, it, vi } from 'vitest'

import type { TickSignalSource, TickSignalSubscription } from './integration-tick-signal'
import {
  createSqlTickSignalSource,
  DEFAULT_PROBE_TIMEOUT_MS,
  isProbePayload,
  probePayload,
  runTickTransportProbe,
  SIGNALLED_TICK_TRIGGER,
  startTickSignalListener,
  TICK_SIGNAL_CHANNEL,
  TRANSPORT_UNVERIFIED_REASON,
} from './integration-tick-signal'

/**
 * The listener on the other end of `NOTIFY sisyphus_integration_tick`.
 *
 * Every test here runs against a fake transport: nothing opens a connection, and no notification
 * reaches a real database. The two properties worth settling are the ones spike S3 makes non-obvious
 * — that a transport delivering nothing is **reported** rather than silently tolerated, and that a
 * delivered id turns into exactly one manual tick.
 */

const INTEGRATION_A = '0199a1f4-0000-7000-8000-00000000000a'
const INTEGRATION_B = '0199a1f4-0000-7000-8000-00000000000b'

/** A transport that behaves: whatever is emitted comes back to every subscriber. */
const workingSource = (): TickSignalSource & { readonly deliver: (payload: string) => void } => {
  const subscribers = new Set<(payload: string) => void>()

  return {
    deliver: (payload) => {
      for (const subscriber of subscribers) {
        subscriber(payload)
      }
    },
    subscribe: (_channel, onPayload): Promise<TickSignalSubscription> => {
      subscribers.add(onPayload)

      return Promise.resolve({
        close: () => {
          subscribers.delete(onPayload)
          return Promise.resolve()
        },
      })
    },
    emit: (_channel, payload) => {
      for (const subscriber of subscribers) {
        subscriber(payload)
      }
      return Promise.resolve()
    },
  }
}

/**
 * A transport that accepts the subscription and delivers nothing — the pooler, exactly as measured.
 * No error, no rejection, no close.
 */
const silentlyBrokenSource = (): TickSignalSource => ({
  subscribe: () => Promise.resolve({ close: () => Promise.resolve() }),
  emit: () => Promise.resolve(),
})

describe('the tick signal channel', () => {
  it('is the literal both runNow and the webhook notify on', () => {
    // Restated in three places by necessity; pinned here so a rename fails rather than disconnects.
    expect(TICK_SIGNAL_CHANNEL).toBe('sisyphus_integration_tick')
  })

  it('cannot mistake a probe for an integration id', () => {
    expect(isProbePayload(probePayload('t1'))).toBe(true)
    expect(isProbePayload(INTEGRATION_A)).toBe(false)
  })

  it('records a signalled tick as manual, because an admin asked for it (FR-097)', () => {
    expect(SIGNALLED_TICK_TRIGGER).toBe('manual')
  })
})

describe('startTickSignalListener', () => {
  it('proves the transport before reporting itself usable', async () => {
    const onTransportLost = vi.fn()
    const listener = await startTickSignalListener({
      source: workingSource(),
      tick: () => Promise.resolve(),
      onTransportLost,
    })

    expect(listener.verified()).toBe(true)
    expect(onTransportLost).not.toHaveBeenCalled()

    await listener.close()
  })

  it('ticks the integration a delivered id names, exactly once', async () => {
    const source = workingSource()
    const tick = vi.fn(() => Promise.resolve())

    const listener = await startTickSignalListener({
      source,
      tick,
      onTransportLost: vi.fn(),
    })

    source.deliver(INTEGRATION_A)
    await vi.waitFor(() => {
      expect(tick).toHaveBeenCalledWith(INTEGRATION_A)
    })
    expect(tick).toHaveBeenCalledTimes(1)

    await listener.close()
  })

  it('never ticks its own probe', async () => {
    const source = workingSource()
    const tick = vi.fn(() => Promise.resolve())

    const listener = await startTickSignalListener({ source, tick, onTransportLost: vi.fn() })

    expect(tick).not.toHaveBeenCalled()

    await listener.close()
  })

  it('collapses a signal that arrives mid-tick into one follow-up, not a pile (FR-103)', async () => {
    const source = workingSource()
    let release = (): void => undefined
    const inFlight = new Promise<void>((resolve) => {
      release = resolve
    })
    const tick = vi.fn(async () => inFlight)

    const listener = await startTickSignalListener({ source, tick, onTransportLost: vi.fn() })

    source.deliver(INTEGRATION_A)
    source.deliver(INTEGRATION_A)
    source.deliver(INTEGRATION_A)
    expect(tick).toHaveBeenCalledTimes(1)

    release()
    await vi.waitFor(() => {
      expect(tick).toHaveBeenCalledTimes(2)
    })

    await listener.close()
  })

  it('keeps listening when one board throws — a bad board is not a bad channel', async () => {
    const source = workingSource()
    const onTickFailed = vi.fn()
    const tick = vi.fn((integrationId: string) =>
      integrationId === INTEGRATION_A
        ? Promise.reject(new Error('that board is unreachable'))
        : Promise.resolve(),
    )

    const listener = await startTickSignalListener({
      source,
      tick,
      onTransportLost: vi.fn(),
      onTickFailed,
    })

    source.deliver(INTEGRATION_A)
    await vi.waitFor(() => {
      expect(onTickFailed).toHaveBeenCalledWith(INTEGRATION_A, expect.any(Error))
    })

    source.deliver(INTEGRATION_B)
    await vi.waitFor(() => {
      expect(tick).toHaveBeenCalledWith(INTEGRATION_B)
    })

    await listener.close()
  })

  describe('against a transport that accepts the subscription and delivers nothing (spike S3)', () => {
    it('reports it rather than looking healthy', async () => {
      const onTransportLost = vi.fn()

      const listener = await startTickSignalListener({
        source: silentlyBrokenSource(),
        tick: () => Promise.resolve(),
        onTransportLost,
        probeTimeoutMs: 5,
      })

      expect(listener.verified()).toBe(false)
      expect(onTransportLost).toHaveBeenCalledWith(TRANSPORT_UNVERIFIED_REASON)

      await listener.close()
    })

    it('names the pooler and what to do, because there is no error to read', () => {
      expect(TRANSPORT_UNVERIFIED_REASON).toContain('pooler')
      expect(TRANSPORT_UNVERIFIED_REASON).toContain('direct connection')
    })

    it('fails the probe job rather than succeeding with bad news', async () => {
      const listener = await startTickSignalListener({
        source: silentlyBrokenSource(),
        tick: () => Promise.resolve(),
        onTransportLost: vi.fn(),
        probeTimeoutMs: 5,
      })

      const outcome = await runTickTransportProbe(listener)

      expect(outcome.ok).toBe(false)

      await listener.close()
    })
  })

  it('re-proves on demand, so a pool recycle mid-life is caught too', async () => {
    const source = workingSource()
    const listener = await startTickSignalListener({
      source,
      tick: () => Promise.resolve(),
      onTransportLost: vi.fn(),
    })

    await expect(runTickTransportProbe(listener)).resolves.toMatchObject({ ok: true })

    await listener.close()
  })

  it('gives a slow database longer than a dead channel by default', () => {
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000)
  })
})

describe('createSqlTickSignalSource', () => {
  it('listens and notifies on the handle it is given, and nothing else', async () => {
    const unlisten = vi.fn(() => Promise.resolve())
    const listen = vi.fn(() => Promise.resolve({ unlisten }))
    const notify = vi.fn(() => Promise.resolve())

    const source = createSqlTickSignalSource({ listen, notify })
    const subscription = await source.subscribe(TICK_SIGNAL_CHANNEL, () => undefined)
    await source.emit(TICK_SIGNAL_CHANNEL, 'payload')
    await subscription.close()

    expect(listen).toHaveBeenCalledWith(TICK_SIGNAL_CHANNEL, expect.any(Function))
    expect(notify).toHaveBeenCalledWith(TICK_SIGNAL_CHANNEL, 'payload')
    expect(unlisten).toHaveBeenCalled()
  })
})
