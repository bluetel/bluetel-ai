import { describe, expect, it } from 'vitest'

import * as iterations from './index'

describe('the iterations barrel', () => {
  it('exports the card and the shaping behind it', () => {
    expect(typeof iterations.IterationTimelineCard).toBe('function')
    expect(typeof iterations.toIterationTimelineReadouts).toBe('function')
  })

  it('exports nothing that would act on a run', () => {
    // A fourth iteration is refused by the `iterations_ordinal_bounds` check constraint (FR-061),
    // so anything here that offered to start one would be offering something that cannot happen.
    expect(
      Object.keys(iterations).filter((name) => /retry|rerun|start|cancel|resume/iu.test(name)),
    ).toEqual([])
  })

  it('states the bound as a label, and does not pretend to enforce it', () => {
    expect(iterations.MAX_ITERATIONS).toBe(3)
    expect(iterations.toIterationTimelineReadouts([]).readout).toBe('0 of 3')
  })
})
