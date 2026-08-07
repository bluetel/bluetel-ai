import { z } from 'zod'

import { cursorPagination, nonEmptyText, uuidInput } from './common'

/**
 * Inputs for `admin.workspaces` — the repository sets a run checks out (FR-109..FR-111, FR-125).
 *
 * An edit submits the **whole entry list**, not a patch. Editing creates a new immutable version
 * and in-flight runs keep the version they started with (FR-125, FR-149); a patch API would make
 * "what did this version contain" a question you answer by replaying edits, which is exactly what
 * versioning is supposed to remove.
 */

/** One repository in a workspace version. */
export const workspaceEntryInput = z.object({
  repositoryUrl: nonEmptyText,
  baseBranch: nonEmptyText,
  /**
   * Where the repository is checked out beneath the pinned root. Validated to resolve *inside*
   * that root and rejected otherwise, so a `../` cannot escape it (FR-111).
   */
  subdirectory: nonEmptyText,
  isPrimary: z.boolean().default(false),
  position: z.number().int().nonnegative(),
})

/**
 * Exactly one primary entry per version (FR-110), and no repeated subdirectory (FR-111).
 *
 * Both are database constraints as well. They are checked here too so the panel can point at the
 * offending row instead of surfacing a unique-violation, and so the rule is stated once in a form
 * the form and the resolver share.
 */
export const workspaceEntryListInput = z
  .array(workspaceEntryInput)
  .min(1)
  .superRefine((entries, ctx) => {
    const primaries = entries.filter((entry) => entry.isPrimary)
    if (primaries.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Exactly one entry must be marked primary.',
      })
    }

    const subdirectories = new Set(entries.map((entry) => entry.subdirectory))
    if (subdirectories.size !== entries.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Each entry must check out into its own subdirectory.',
      })
    }
  })

export const workspaceIdInput = z.object({ workspaceId: uuidInput })

export const listWorkspacesInput = cursorPagination.extend({
  enabledOnly: z.boolean().default(false),
  includeArchived: z.boolean().default(false),
})

export const createWorkspaceInput = z.object({
  name: nonEmptyText,
  description: z.string().optional(),
  entries: workspaceEntryListInput,
})

/** Creates a new version and advances `currentVersionId`; running workflows are untouched. */
export const updateWorkspaceInput = z.object({
  workspaceId: uuidInput,
  name: nonEmptyText.optional(),
  description: z.string().nullish(),
  entries: workspaceEntryListInput,
})

/** Copy an existing workspace's current version as the starting point for a new one (FR-127). */
export const cloneWorkspaceInput = z.object({
  workspaceId: uuidInput,
  name: nonEmptyText,
})

export const setWorkspaceEnabledInput = z.object({
  workspaceId: uuidInput,
  enabled: z.boolean(),
})

export type WorkspaceEntryInput = z.infer<typeof workspaceEntryInput>
export type WorkspaceIdInput = z.infer<typeof workspaceIdInput>
export type ListWorkspacesInput = z.infer<typeof listWorkspacesInput>
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInput>
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceInput>
export type CloneWorkspaceInput = z.infer<typeof cloneWorkspaceInput>
export type SetWorkspaceEnabledInput = z.infer<typeof setWorkspaceEnabledInput>
