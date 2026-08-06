/**
 * The delivery path — draft pull request, staleness, and the ports both are
 * built on (T069, T070).
 *
 * Consumers import from here and never from the modules behind it. Three
 * guarantees the barrel is holding in place, each of them structural rather
 * than a matter of care:
 *
 * - **Nothing here changes a repository.** The only git access exported is
 *   {@link createGitReader}, whose runner refuses every mutating subcommand.
 *   Whether to rebase a stale branch belongs to the repository's skills
 *   (FR-079).
 * - **Nothing here transitions a ticket.** The {@link Forge} port has no method
 *   that could, which is how FR-060 keeps delivery ownership with the
 *   initiating engineer.
 * - **Nothing here invents a convention.** Branch, base, remote and title come
 *   from `sisyphus-dev` through {@link requireDeliveryConventions}, which halts
 *   naming the skill and the step rather than guessing (FR-058).
 */

export { DEV_SKILL_NAME, requireDeliveryConventions, skillConventionError } from './conventions'
export type { DeliveryConventions } from './conventions'

export {
  createExternalActionLedger,
  EXTERNAL_ACTION_KEY_SEPARATOR,
  externalActionKey,
  pendingExternalActions,
  performExternalAction,
  PULL_REQUEST_ACTION,
  pullRequestIdentity,
} from './external-action'
export type {
  ExternalAction,
  ExternalActionDisposition,
  ExternalActionEntry,
  ExternalActionIdentity,
  ExternalActionLedger,
  ExternalActionOutcome,
} from './external-action'

export { pullRequestIdempotencyKey } from './forge'
export type { CreatePullRequestInput, Forge, PullRequestRef } from './forge'

export {
  createGitReader,
  createGuardedGitRunner,
  createProcessGitRunner,
  FORBIDDEN_GIT_COMMANDS,
  mutatingGitCommandError,
  READ_ONLY_GIT_COMMANDS,
} from './git'
export type { GitCommand, GitCommandResult, GitReader, GitReaderOptions, GitRunner } from './git'

export {
  branchNotOnForgeError,
  DELIVERY_STEP,
  noPushedWorkError,
  openDraftPullRequest,
  unpushedCommitError,
} from './pull-request'
export type { OpenDraftPullRequestInput, PullRequestDelivery } from './pull-request'

export {
  crossReference,
  openPullRequestSet,
  PULL_REQUEST_SET_STEP,
  selfProposedBranchError,
} from './pull-request-set'
export type {
  OpenPullRequestSetInput,
  PullRequestSet,
  PullRequestSetEntry,
  PullRequestSetMember,
  PullRequestSetOutcome,
} from './pull-request-set'

export { PROMOTION_SKILL_NAME, promotionOrderError, requirePromotionOrder } from './promotion-order'
export type { DeclaredPromotionOrder, OrderableEntry, PromotionStep } from './promotion-order'

export {
  assessStaleness,
  createArtifactStalenessRecorder,
  REBASE_DECISION,
  recordStaleness,
} from './staleness'
export type {
  ArtifactStalenessRecorderOptions,
  StalenessAssessment,
  StalenessCheck,
  StalenessRecorder,
  StalenessState,
} from './staleness'
