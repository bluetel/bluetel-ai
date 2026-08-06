import { describe, expect, it } from 'vitest'

import * as barrel from './index'

describe('the webhook barrel', () => {
  it('exports the pipeline, the guard and the verifier', () => {
    expect(Object.keys(barrel).sort()).toStrictEqual([
      'IDENTITY_FIELDS',
      'KEY_ID_HEADER',
      'REPLAY_WINDOW_MS',
      'SIGNATURE_HEADER',
      'SIGNATURE_VERSION',
      'TIMESTAMP_HEADER',
      'createMemoryReplayStore',
      'deriveIntegrationKey',
      'handleDelivery',
      'signDelivery',
      'signedPayload',
      'verifyDelivery',
    ])
  })

  it('does not export the route module, which opens a pool when it runs', () => {
    expect('POST' in barrel).toBe(false)
  })
})
