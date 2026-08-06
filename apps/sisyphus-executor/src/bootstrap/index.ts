/**
 * Bootstrap — the ordered, individually timed phases that turn a bare instance
 * into a worker and then start the agent (T046, T055).
 *
 * Consumers import from here and never from the modules behind it. That is not
 * only convention: the barrel is what keeps `ReadyWorkspace` the only route
 * from phase 6 to phase 7. `checkoutWorkspace` is the sole construction site
 * for the brand and `startAgentPhase` is the sole consumer, so there is no
 * supported way to start an agent against a workspace that did not finish
 * checking out (FR-112).
 */

export { startAgentPhase } from './agent-start'
export type { StartAgentOptions, StartedAgent } from './agent-start'

export {
  ARCHIVE_NOT_FOUND,
  codedError,
  createFakeArchiveStore,
  isCodedError,
} from './archive-store'
export type { ArchiveLocation, BundleArchiveStore, CodedError } from './archive-store'

export {
  assertSetupScript,
  downloadArchive,
  runBundleBootstrap,
  runSetupScript,
  SETUP_SCRIPT_IDEMPOTENCY_NOTE,
  SETUP_SCRIPT_NAME,
  sha256Hex,
  unpackArchive,
  verifyArchiveDigest,
} from './bundle'
export type { BundleBootstrapOptions, BundleBootstrapResult, SetupBundleReference } from './bundle'

export {
  BOOTSTRAP_PHASES,
  BootstrapPhaseError,
  DEFAULT_PHASE_TIMEOUTS,
  nullPhaseReporter,
  runPhase,
} from './phases'
export type {
  BootstrapPhaseFinished,
  BootstrapPhaseName,
  BootstrapPhaseOutcome,
  BootstrapPhaseReporter,
  BootstrapPhaseStarted,
  RunPhaseContext,
} from './phases'

export { describeExit, runCommand } from './run-command'
export type { CommandResult, RunCommandOptions } from './run-command'

export {
  AGENT_CONFIG_DIR_NAME,
  agentConfigDir,
  checkoutEntry,
  checkoutWorkspace,
  PINNED_WORKSPACE_ROOT,
  prepareWorkspaceRoot,
  resolveEntryPath,
  validateEntries,
} from './workspace'
export type {
  CheckedOutEntry,
  CheckoutWorkspaceOptions,
  PlannedEntry,
  ReadyWorkspace,
  WorkspaceEntry,
} from './workspace'
