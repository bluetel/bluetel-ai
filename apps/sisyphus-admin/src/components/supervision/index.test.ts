import { describe, expect, it } from 'vitest'

import * as supervision from './index'

describe('the supervision barrel', () => {
  it('exports the controls and the correction list', () => {
    expect(typeof supervision.SupervisionControls).toBe('function')
    expect(typeof supervision.CorrectionList).toBe('function')
  })

  it('exports the derivation the controls are not allowed to bypass', () => {
    expect(typeof supervision.supervisionStatus).toBe('function')
    expect(typeof supervision.supervisionReadout).toBe('function')
    expect(typeof supervision.isConfirmedPause).toBe('function')
  })

  it('offers no way to declare a run paused directly', () => {
    // "Paused" is a conclusion drawn from the recorded state and a queued command, and this barrel
    // gives a caller nothing that would let it assert one instead.
    const setters = Object.keys(supervision).filter((name) =>
      /^(setPaused|markPaused|pause)$/.test(name),
    )

    expect(setters).toStrictEqual([])
  })
})
