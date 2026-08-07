import { describe, expect, it, vi } from 'vitest'

import { runJob, toError } from './run-job'

const fakeClock = (...ticks: number[]) => {
  let index = 0

  return () => {
    const tick = ticks[Math.min(index, ticks.length - 1)] ?? 0
    index += 1

    return tick
  }
}

describe('toError', () => {
  it('passes an Error through unchanged', () => {
    const original = new Error('boom')

    expect(toError(original)).toBe(original)
  })

  it('wraps a non-Error throw without losing its content', () => {
    expect(toError('not an error')).toBeInstanceOf(Error)
    expect(toError('not an error').message).toBe('not an error')
  })
})

describe('runJob', () => {
  it('reports the resolved value on success', async () => {
    const outcome = await runJob('reconcile', () => 42, fakeClock(1_000, 1_250))

    expect(outcome).toStrictEqual({
      ok: true,
      jobName: 'reconcile',
      durationMs: 250,
      value: 42,
    })
  })

  it('passes the job name through to the handler', async () => {
    const handler = vi.fn(() => 'done')

    await runJob('drain-queue', handler)

    expect(handler).toHaveBeenCalledWith({ jobName: 'drain-queue' })
  })

  it('awaits an async handler', async () => {
    const outcome = await runJob('start-workflow', () => Promise.resolve('started'))

    expect(outcome.ok && outcome.value).toBe('started')
  })

  it('captures a rejection instead of throwing', async () => {
    const failure = new Error('provisioning failed')

    const outcome = await runJob('start-workflow', () => Promise.reject(failure))

    expect(outcome).toStrictEqual({
      ok: false,
      jobName: 'start-workflow',
      durationMs: expect.any(Number) as number,
      error: failure,
    })
  })

  it('captures a synchronous throw', async () => {
    const outcome = await runJob('teardown-workflow', () => {
      throw new Error('lease still held')
    })

    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.error.message).toBe('lease still held')
  })

  it('still reports a duration when the handler fails', async () => {
    const outcome = await runJob(
      'integration-tick',
      () => {
        throw new Error('nope')
      },
      fakeClock(500, 900),
    )

    expect(outcome.durationMs).toBe(400)
  })
})
