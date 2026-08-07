import { createEnumGuard } from './enum-guard'

/**
 * The two roles in the platform (FR-166).
 *
 * Users are auto-created as `engineer` on first successful sign-in (FR-170); every route to
 * `admin` requires an existing admin to grant it, or the deploy-time bootstrap reconcile
 * (FR-174). At least one active admin must exist at all times (FR-173).
 */
export const USER_ROLES = ['engineer', 'admin'] as const

export type UserRole = (typeof USER_ROLES)[number]

export const isUserRole = createEnumGuard(USER_ROLES)

/** The role a user is created with when they first sign in (FR-170). */
export const DEFAULT_USER_ROLE: UserRole = 'engineer'
