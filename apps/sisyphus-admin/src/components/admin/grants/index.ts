/**
 * The per-profile access screen (T043, US13).
 *
 * The page imports {@link ProfileAccessPanel} and nothing else; the rest is exported for the
 * colocated tests and for the user-side access list that reads the same table from the other
 * direction. Consumers import this barrel, never a module inside it.
 */

export { isLiveGrant, liveGrantHolderIds, toGrantReadouts } from './grant-listing'
export type { GrantReadouts, ProfileGrant } from './grant-listing'

export { GrantRow } from './grant-row'

export { IssueGrantForm } from './issue-grant-form'
export type { GrantCandidate } from './issue-grant-form'

export { ProfileAccessPanel } from './profile-access-panel'

export {
  describeGrantError,
  describeGrantResult,
  describeRevocationCascade,
  describeRevocationResult,
} from './revocation-outcome'
export type { GrantIssued, GrantNotice, GrantRevoked } from './revocation-outcome'

export { RevokeConfirmation } from './revoke-confirmation'
