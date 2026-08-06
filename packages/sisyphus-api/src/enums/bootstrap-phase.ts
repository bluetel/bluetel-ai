import { createEnumGuard } from './enum-guard'

/**
 * The bootstrap steps, in the order the executor protocol runs them.
 *
 * Order is part of the vocabulary, not a presentation detail: each phase has its own timeout, so
 * exceeding one fails the workflow **naming the phase that hung** rather than producing a generic
 * bootstrap timeout (FR-145, FR-146). Reordering these renames which step a stored row refers to,
 * so it is a migration.
 */
export const BOOTSTRAP_PHASES = [
  'provisioning',
  'bundle_download',
  'bundle_verify',
  'bundle_unpack',
  'setup_script',
  'entry_checkout',
  'agent_start',
] as const

export type BootstrapPhase = (typeof BOOTSTRAP_PHASES)[number]

export const isBootstrapPhase = createEnumGuard(BOOTSTRAP_PHASES)
