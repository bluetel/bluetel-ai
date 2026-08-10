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

/**
 * The phases a **bundle validation** run reaches, and no others (T200, FR-147).
 *
 * A validation provisions an instance, fetches and verifies the archive, unpacks it and runs
 * `setup.sh` — and then stops. It has no workspace to check out, no agent to start, and no leased
 * seat to install, so `credential_install`, `entry_checkout` and `agent_start` are not phases it
 * omitted: they are phases that do not exist for it. A result mentioning one would be describing
 * something that did not happen.
 *
 * **It is a prefix of {@link BOOTSTRAP_PHASES} rather than an arbitrary subset**, which is what
 * `bootstrap-phase.test.ts` asserts. That is not decoration: the phases are ordered because each
 * carries its own timeout and a hang is reported by name (FR-145, FR-146), and a validation runs the
 * same phases in the same order that a workflow does — it just stops earlier. A subset that had
 * holes in it would mean a validation was running something other than the beginning of a real boot,
 * which would make it prove less than it appears to.
 *
 * This tuple lives here rather than in the control-plane job that first needed it because it now has
 * three consumers on two sides of a package boundary: the job that starts a validation, the input
 * schema `machine.reportValidation` validates against, and the executor that fills that input in.
 * A literal restated per consumer is how one of them comes to accept `agent_start`.
 */
export const VALIDATION_BOOTSTRAP_PHASES = [
  'provisioning',
  'bundle_download',
  'bundle_verify',
  'bundle_unpack',
  'setup_script',
] as const

export type ValidationBootstrapPhase = (typeof VALIDATION_BOOTSTRAP_PHASES)[number]

export const isValidationBootstrapPhase = createEnumGuard(VALIDATION_BOOTSTRAP_PHASES)
