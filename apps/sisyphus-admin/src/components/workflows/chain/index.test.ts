import { describe, expect, it } from 'vitest'

import * as barrel from './index'

/**
 * The barrel is the directory's public surface, so what it exports is a contract in its own right.
 */
describe('the chain barrel', () => {
  it('exports the screen a page mounts and the panel it renders', () => {
    expect(typeof barrel.WorkflowChainView).toBe('function')
    expect(typeof barrel.WorkflowChainPanel).toBe('function')
  })

  it('exports the model the panel makes no decisions without', () => {
    for (const name of [
      'orderChain',
      'chainNeighbours',
      'summariseChain',
      'toChainReadouts',
      'chainStateReadout',
    ] as const) {
      expect(typeof barrel[name]).toBe('function')
    }
  })

  it('exports the walk and the projection a loader is built from', () => {
    expect(typeof barrel.walkPredecessors).toBe('function')
    expect(typeof barrel.toChainMember).toBe('function')
    expect(barrel.MAX_CHAIN_WALK).toBeGreaterThan(0)
  })
})
