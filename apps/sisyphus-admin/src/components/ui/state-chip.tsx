import type { WorkflowState } from '@bluetel-ai/sisyphus-api/client'
import type { ReactNode } from 'react'

import { stateChipVariants } from './state-chip-variants'
import { StateLed } from './state-led'
import { presentationForState, readoutForState } from './workflow-state-presentation'

interface StateChipProps {
  /** The workflow's state. Omit for the idle chip. This is the **only** input to the chip's colour. */
  state?: WorkflowState
  /**
   * The readout text, when it should say more than the state name — `QUEUED 3`, `RUNNING 04:21`,
   * `PASSED 1,284`. Defaults to the state itself.
   */
  children?: ReactNode
}

/**
 * The signature element (FR-030): a 6px square LED plus a mono readout.
 *
 * It takes no `tone`, no `colour` and no `className`. That is deliberate and is the point of the
 * component: colour here means machine state (FR-025), so the only way to change what a chip looks
 * like is to change what the workflow is doing. A caller that needs the chip positioned differently
 * wraps it; a caller that wants a different colour has misunderstood the system.
 *
 * The pulse comes from the same lookup, so a lamp is animated exactly when a machine is working.
 */
export const StateChip = ({ state, children }: StateChipProps) => {
  const { tone, pulse } = presentationForState(state)

  return (
    <span data-state={state ?? 'idle'} className={stateChipVariants({ tone })}>
      <StateLed pulse={pulse} />
      <span>{children ?? readoutForState(state)}</span>
    </span>
  )
}
