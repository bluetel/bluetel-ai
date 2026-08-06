import { z } from 'zod'

import { USER_ROLES } from '../enums'

import { cursorPagination, nonEmptyText, uuidInput } from './common'

/**
 * Inputs for `admin.users` and `admin.grants` — who exists and what they may see
 * (FR-171..FR-179, FR-184, FR-188).
 *
 * A grant is the unit of access control, and revoking one is a write of `revoked_at` rather than a
 * delete, so the audit trail survives (FR-184). Nothing here can delete a user either:
 * deactivation is not deletion (FR-176).
 */

export const listUsersInput = cursorPagination.extend({
  activeOnly: z.boolean().default(false),
  role: z.enum(USER_ROLES).optional(),
  search: nonEmptyText.optional(),
})

/**
 * Change a role (FR-171..FR-173).
 *
 * `reason` is optional here but the resolver re-counts active admins **inside the transaction**,
 * so the never-zero-admins invariant cannot race two concurrent demotions.
 */
export const setUserRoleInput = z.object({
  userId: uuidInput,
  role: z.enum(USER_ROLES),
  reason: nonEmptyText.optional(),
})

/** Deactivate or reactivate. Takes effect at the next request, not at next sign-in (FR-175). */
export const setUserActiveInput = z.object({
  userId: uuidInput,
  isActive: z.boolean(),
  reason: nonEmptyText.optional(),
})

/** The append-only role and activation audit (FR-177). */
export const listRoleChangesInput = cursorPagination.extend({
  subjectUserId: uuidInput.optional(),
})

export const grantProfileAccessInput = z.object({
  userId: uuidInput,
  executionProfileId: uuidInput,
})

/** Revocation does not affect in-flight workflows the user owns or initiated (FR-188, FR-189). */
export const revokeProfileAccessInput = grantProfileAccessInput

export const listGrantsForProfileInput = cursorPagination.extend({
  executionProfileId: uuidInput,
  includeRevoked: z.boolean().default(false),
})

export const listGrantsForUserInput = cursorPagination.extend({
  userId: uuidInput,
  includeRevoked: z.boolean().default(false),
})

export type ListUsersInput = z.infer<typeof listUsersInput>
export type SetUserRoleInput = z.infer<typeof setUserRoleInput>
export type SetUserActiveInput = z.infer<typeof setUserActiveInput>
export type ListRoleChangesInput = z.infer<typeof listRoleChangesInput>
export type GrantProfileAccessInput = z.infer<typeof grantProfileAccessInput>
export type RevokeProfileAccessInput = z.infer<typeof revokeProfileAccessInput>
export type ListGrantsForProfileInput = z.infer<typeof listGrantsForProfileInput>
export type ListGrantsForUserInput = z.infer<typeof listGrantsForUserInput>
