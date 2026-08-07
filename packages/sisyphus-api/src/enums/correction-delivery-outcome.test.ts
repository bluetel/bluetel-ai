import { describe, expect, it } from 'vitest'

import {
  CORRECTION_DELIVERY_OUTCOMES,
  isCorrectionDeliveryOutcome,
  REPORTABLE_CORRECTION_DELIVERY_OUTCOMES,
} from './correction-delivery-outcome'

describe('CORRECTION_DELIVERY_OUTCOMES', () => {
  it('records a failed delivery rather than dropping it (FR-049, FR-081)', () => {
    expect([...CORRECTION_DELIVERY_OUTCOMES]).toStrictEqual([
      'pending',
      'delivered',
      'failed',
      'rejected',
    ])
  })

  it('guards membership', () => {
    expect(isCorrectionDeliveryOutcome('delivered')).toBe(true)
    expect(isCorrectionDeliveryOutcome('superseded')).toBe(false)
  })
})

describe('REPORTABLE_CORRECTION_DELIVERY_OUTCOMES', () => {
  it('is the full vocabulary minus `pending`, which is the absence of a report', () => {
    expect([...REPORTABLE_CORRECTION_DELIVERY_OUTCOMES]).toStrictEqual(
      [...CORRECTION_DELIVERY_OUTCOMES].filter((outcome) => outcome !== 'pending'),
    )
  })
})
