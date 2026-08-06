import { z } from 'zod'

import { cursorPagination, nonEmptyText, uuidInput } from './common'

/**
 * Inputs for `admin.bundles` — setup bundle registration and versioning (FR-084..FR-092).
 *
 * Bundles are **immutable once registered**: replacing contents creates a version, never mutates
 * one (FR-090). That is why there is a `replaceArchive` input distinct from `updateMetadata` —
 * one produces a new version and the other does not, and a single "update" input would blur the
 * distinction the whole aggregate is built on.
 */

/** A sha256 content digest, lower-case hex. */
export const contentDigest = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Expected a lower-case sha256 digest.')

export const bundleIdInput = z.object({ setupBundleId: uuidInput })

/** Any authenticated user may read the **enabled** list — selecting one builds a profile (FR-086). */
export const listBundlesInput = cursorPagination.extend({
  enabledOnly: z.boolean().default(true),
  includeArchived: z.boolean().default(false),
})

/**
 * Register a bundle and its first version.
 *
 * `spendCapsEnforceable` is declared at registration rather than inferred, because a bundle whose
 * agent cannot enforce a cap must not be silently launched under one (FR-093).
 */
export const registerBundleInput = z.object({
  name: nonEmptyText,
  description: z.string().optional(),
  spendCapsEnforceable: z.boolean().default(false),
  s3Key: nonEmptyText,
  contentDigest,
  sizeBytes: z.number().int().positive(),
})

/** Replace the archive, creating a new version (FR-090). */
export const replaceBundleArchiveInput = z.object({
  setupBundleId: uuidInput,
  s3Key: nonEmptyText,
  contentDigest,
  sizeBytes: z.number().int().positive(),
})

/** Metadata only — deliberately cannot touch archive contents. */
export const updateBundleMetadataInput = z.object({
  setupBundleId: uuidInput,
  name: nonEmptyText.optional(),
  description: z.string().nullish(),
  spendCapsEnforceable: z.boolean().optional(),
})

export const setBundleEnabledInput = z.object({
  setupBundleId: uuidInput,
  enabled: z.boolean(),
})

/** Prove a bundle without starting an agent (FR-147, FR-148). */
export const validateBundleInput = z.object({ setupBundleVersionId: uuidInput })

/** What would break if this bundle were archived (FR-092). */
export const bundleReferencesInput = bundleIdInput

export type BundleIdInput = z.infer<typeof bundleIdInput>
export type ListBundlesInput = z.infer<typeof listBundlesInput>
export type RegisterBundleInput = z.infer<typeof registerBundleInput>
export type ReplaceBundleArchiveInput = z.infer<typeof replaceBundleArchiveInput>
export type UpdateBundleMetadataInput = z.infer<typeof updateBundleMetadataInput>
export type SetBundleEnabledInput = z.infer<typeof setBundleEnabledInput>
export type ValidateBundleInput = z.infer<typeof validateBundleInput>
