import { z } from 'zod'

import { CLAUDE_MODELS, PURCHASE_MODES, WORKFLOW_TYPES } from '../enums'

import { cursorPagination, moneyAmount, nonEmptyText, uuidInput } from './common'

/**
 * Inputs for `admin.profiles` — execution profiles, the unit of access control (FR-121..FR-128).
 *
 * A profile version pins the **bundle version and workspace version**, not just their ids: a
 * profile that validated against one bundle version has not been silently re-pointed at another.
 * That is why creating and updating both name versions rather than parents.
 */

/**
 * Fields a profile may lock against per-run override (FR-123).
 *
 * A closed set rather than free-form strings, so a typo in a locked-field name cannot silently
 * lock nothing — which would be indistinguishable from a working configuration until someone
 * overrode the field it was supposed to protect.
 */
export const LOCKABLE_PROFILE_FIELDS = [
  'model',
  'instanceType',
  'purchaseMode',
  'turnCap',
  'spendCap',
  'workflowType',
] as const

export const lockableProfileField = z.enum(LOCKABLE_PROFILE_FIELDS)

/** Everything a launch takes from the profile. Snapshotted whole onto each version (FR-065). */
export const profileVersionInput = z.object({
  workspaceVersionId: uuidInput,
  setupBundleVersionId: uuidInput,
  model: z.enum(CLAUDE_MODELS),
  instanceType: nonEmptyText,
  purchaseMode: z.enum(PURCHASE_MODES),
  turnCap: z.number().int().positive().nullish(),
  spendCap: moneyAmount.nullish(),
  defaultWorkflowType: z.enum(WORKFLOW_TYPES),
  promptPreamble: z.string().nullish(),
  lockedFields: z.array(lockableProfileField).default([]),
})

export const profileIdInput = z.object({ executionProfileId: uuidInput })

export const listProfilesInput = cursorPagination.extend({
  enabledOnly: z.boolean().default(false),
  includeArchived: z.boolean().default(false),
})

export const createProfileInput = profileVersionInput.extend({
  name: nonEmptyText,
  description: z.string().optional(),
})

/** Creates a new version; workflows already running keep the version they launched with. */
export const updateProfileInput = profileVersionInput.extend({
  executionProfileId: uuidInput,
  name: nonEmptyText.optional(),
  description: z.string().nullish(),
})

export const cloneProfileInput = z.object({
  executionProfileId: uuidInput,
  name: nonEmptyText,
})

/**
 * Enabling runs the FR-124 validation gate — bundle enabled **and** every workspace entry
 * reachable — and refuses naming the failing element rather than reporting a generic failure.
 */
export const setProfileEnabledInput = z.object({
  executionProfileId: uuidInput,
  enabled: z.boolean(),
})

export type LockableProfileField = z.infer<typeof lockableProfileField>
export type ProfileVersionInput = z.infer<typeof profileVersionInput>
export type ProfileIdInput = z.infer<typeof profileIdInput>
export type ListProfilesInput = z.infer<typeof listProfilesInput>
export type CreateProfileInput = z.infer<typeof createProfileInput>
export type UpdateProfileInput = z.infer<typeof updateProfileInput>
export type CloneProfileInput = z.infer<typeof cloneProfileInput>
export type SetProfileEnabledInput = z.infer<typeof setProfileEnabledInput>
