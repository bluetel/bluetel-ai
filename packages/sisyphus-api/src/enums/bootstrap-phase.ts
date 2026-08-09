import { createEnumGuard } from './enum-guard'

/**
 * The bootstrap steps, in the order the executor protocol runs them.
 *
 * Order is part of the vocabulary, not a presentation detail: each phase has its own timeout, so
 * exceeding one fails the workflow **naming the phase that hung** rather than producing a generic
 * bootstrap timeout (FR-145, FR-146). Reordering these renames which step a stored row refers to,
 * so it is a migration.
 *
 * `credential_install` is inserted between `setup_script` and `entry_checkout` for that reason
 * rather than appended (003/FR-049, research R7): the agent credential is fetched from the
 * workflow's lease once the bundle has put the agent CLI in place, and before any workspace work
 * begins. Appending it would have avoided the migration at the cost of placing credential
 * installation after `agent_start` in the vocabulary — wrong, and not detectable afterwards. It
 * runs on **every** boot, including restore and resumed-instance boots (003/FR-050), because
 * material may have rotated while the instance was stopped, and it can fail only on transport:
 * availability was already guaranteed when the workflow was admitted.
 */
export const BOOTSTRAP_PHASES = [
  'provisioning',
  'bundle_download',
  'bundle_verify',
  'bundle_unpack',
  'setup_script',
  'credential_install',
  'entry_checkout',
  'agent_start',
] as const

export type BootstrapPhase = (typeof BOOTSTRAP_PHASES)[number]

export const isBootstrapPhase = createEnumGuard(BOOTSTRAP_PHASES)
