/**
 * The user-management screen (T039, US12).
 *
 * The page imports {@link UsersPanel} and nothing else; the rest is exported for the colocated
 * tests and for a later screen that needs the same shaping. Consumers import this barrel, never a
 * module inside it.
 */

export { RoleChangeHistory } from './role-change-history'
export { SYSTEM_ACTOR, NO_REASON, toRoleChangeReadouts } from './role-change-entry'
export type { RoleChangeEntry, RoleChangeReadouts } from './role-change-entry'

export { UserActionForm } from './user-action-form'
export { availableUserActions, userAction } from './user-actions'
export type { UserAction, UserActionKind } from './user-actions'

export { UserCard } from './user-card'

export {
  describeUserChange,
  describeUserChangeError,
  LAST_ACTIVE_ADMIN_ERROR,
} from './user-change-outcome'
export type { UserChangeNotice, UserChangeResult } from './user-change-outcome'

export { hasWorkInFlight, toUserReadouts } from './user-listing'
export type { AdministeredUser, UserReadouts } from './user-listing'

export { UsersPanel } from './users-panel'
