/**
 * The panel's one primitive set (FR-033).
 *
 * Every piece of UI in the console is built from what is exported here, and class composition goes
 * through the single shared `cn`. A hand-rolled button, badge or input elsewhere in the app is a
 * duplicate rather than a variation — if a primitive does not do what a page needs, the variant
 * belongs in the primitive.
 *
 * Consumers import this barrel, never a module inside it.
 */

export { Button, type ButtonProps } from './button'
export { buttonVariants, type ButtonVariant, type ButtonVariantProps } from './button-variants'

export { Card } from './card'
export { CardBody } from './card-body'
export { CardHeader } from './card-header'

export { Field, type FieldProps } from './field'
export { FieldControl, type FieldControlProps } from './field-control'
export { fieldControlVariants, type FieldControlVariantProps } from './field-control-variants'
export { FieldError, type FieldErrorContent } from './field-error'
export { FieldLabel } from './field-label'

export { FOCUS_RING } from './focus-ring'

export { Meter, meterFillPercent } from './meter'

export { StateChip } from './state-chip'
export { stateChipVariants, type StateChipVariantProps } from './state-chip-variants'
export { StateLed } from './state-led'

export {
  IDLE_PRESENTATION,
  presentationForState,
  readoutForState,
  STATE_TONES,
  type StatePresentation,
  type StateTone,
  WORKFLOW_STATE_PRESENTATION,
} from './workflow-state-presentation'
