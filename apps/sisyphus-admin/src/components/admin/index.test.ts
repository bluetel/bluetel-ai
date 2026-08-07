import { describe, expect, it } from 'vitest'

import * as admin from './index'

describe('the shared admin barrel', () => {
  it('publishes the behaviour the two screens share', () => {
    expect(Object.keys(admin).sort()).toStrictEqual([
      'AdminShell',
      'ChangeNotice',
      'DataReadout',
      'ElapsedReadout',
      'MAPPED_TRPC_ERROR_CODES',
      'NEVER',
      'NotFoundCard',
      'UNEXPECTED_ERROR',
      'describeTrpcError',
      'elapsedReadout',
      'formatElapsed',
      'formatTimestamp',
      'isNotFoundError',
      'readTrpcErrorCode',
    ])
  })

  it('publishes no primitive of its own, because there is exactly one primitive set', () => {
    for (const primitive of ['Button', 'Card', 'Field', 'StateChip', 'Meter', 'cn']) {
      expect(Object.keys(admin)).not.toContain(primitive)
    }
  })
})
