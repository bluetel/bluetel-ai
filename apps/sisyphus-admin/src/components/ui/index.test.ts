import { describe, expect, it } from 'vitest'

import * as ui from './index'

describe('the primitive barrel', () => {
  it('publishes every primitive the panel is built from', () => {
    expect(Object.keys(ui).sort()).toStrictEqual([
      'Button',
      'Card',
      'CardBody',
      'CardHeader',
      'EmptyState',
      'FOCUS_RING',
      'Field',
      'FieldControl',
      'FieldError',
      'FieldLabel',
      'IDLE_PRESENTATION',
      'LoadingState',
      'Meter',
      'STATE_TONES',
      'StateChip',
      'StateLed',
      'WORKFLOW_STATE_PRESENTATION',
      'buttonVariants',
      'fieldControlVariants',
      'meterFillPercent',
      'presentationForState',
      'readoutForState',
      'stateChipVariants',
    ])
  })

  it('exposes no second class-merge helper, because there is exactly one', () => {
    expect(Object.keys(ui)).not.toContain('cn')
    expect(Object.keys(ui)).not.toContain('classNames')
  })

  it('keeps the panel note unpublished, so a screen has to say which state it is in', () => {
    expect(Object.keys(ui)).not.toContain('PanelNote')
  })
})
