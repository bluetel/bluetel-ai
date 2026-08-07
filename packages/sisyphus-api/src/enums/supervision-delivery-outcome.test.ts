import { describe, expect, it } from 'vitest'

import { CORRECTION_DELIVERY_OUTCOMES } from './correction-delivery-outcome'
import {
  isSupervisionDeliveryOutcome,
  REPORTABLE_SUPERVISION_DELIVERY_OUTCOMES,
  SUPERVISION_DELIVERY_OUTCOMES,
} from './supervision-delivery-outcome'

describe('SUPERVISION_DELIVERY_OUTCOMES', () => {
  it('starts at pending, the state a command holds before anyone has answered', () => {
    expect(SUPERVISION_DELIVERY_OUTCOMES[0]).toBe('pending')
  })

  it('carries `superseded`, which is the whole reason it is not the corrections vocabulary', () => {
    expect(SUPERVISION_DELIVERY_OUTCOMES).toContain('superseded')
    expect([...CORRECTION_DELIVERY_OUTCOMES]).not.toContain('superseded')
  })

  it('guards membership', () => {
    expect(isSupervisionDeliveryOutcome('superseded')).toBe(true)
    expect(isSupervisionDeliveryOutcome('delivered')).toBe(false)
  })
})

describe('REPORTABLE_SUPERVISION_DELIVERY_OUTCOMES', () => {
  it('is the full vocabulary minus `pending` — an executor cannot report not having answered', () => {
    expect([...REPORTABLE_SUPERVISION_DELIVERY_OUTCOMES]).toStrictEqual(
      [...SUPERVISION_DELIVERY_OUTCOMES].filter((outcome) => outcome !== 'pending'),
    )
  })
})
