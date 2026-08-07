import { describe, expect, it } from 'vitest'

import * as supervision from './index'

describe('the supervision barrel', () => {
  it('exports the two loops and nothing that would drive them for you', () => {
    expect(typeof supervision.createSupervisionPoller).toBe('function')
    expect(typeof supervision.createCorrectionDeliverer).toBe('function')
  })

  it('exports the SC-003 arithmetic as numbers a caller can check', () => {
    expect(typeof supervision.pauseLatencyBudget).toBe('function')
    expect(supervision.PAUSE_LATENCY_CEILING_MS).toBe(10_000)
    expect(supervision.pauseLatencyBudget().slackMs).toBeGreaterThan(0)
  })

  it('exports the unconfirmed-delivery reason, so nothing has to reinvent the wording', () => {
    expect(supervision.UNCONFIRMED_DELIVERY_REASON).toContain('never acknowledged')
  })

  it('offers no way to send a turn or stop an agent from here', () => {
    // The correction path holds a narrowed `CorrectionSender`, not an adapter. A barrel that
    // re-exported an agent action would be one edit away from a supervision loop that could
    // terminate a run it was only meant to steer.
    const dangerous = Object.keys(supervision).filter((name) =>
      /^(sendTurn|stop|quiesce|start)$/.test(name),
    )

    expect(dangerous).toStrictEqual([])
  })
})
