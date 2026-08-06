import { createEnumGuard } from './enum-guard'

/**
 * How one bootstrap phase ended.
 *
 * `timed_out` is separate from `failed` because the two lead somewhere different: a phase that ran
 * out of time names a budget that was too small, whereas a failure names something that went wrong
 * inside it. Collapsing them would lose the distinction FR-146 exists to preserve.
 */
export const BOOTSTRAP_PHASE_OUTCOMES = ['succeeded', 'failed', 'timed_out'] as const

export type BootstrapPhaseOutcome = (typeof BOOTSTRAP_PHASE_OUTCOMES)[number]

export const isBootstrapPhaseOutcome = createEnumGuard(BOOTSTRAP_PHASE_OUTCOMES)
