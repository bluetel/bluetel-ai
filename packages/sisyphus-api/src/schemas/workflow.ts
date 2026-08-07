import { z } from 'zod'

import { CLAUDE_MODELS, PURCHASE_MODES, WORKFLOW_STATES, WORKFLOW_TYPES } from '../enums'

import { cursorPagination, dateRange, moneyAmount, nonEmptyText, uuidInput } from './common'

/**
 * Inputs for the `workflow` router — launching, reading and supervising a run.
 *
 * Every one of these is consumed twice: by the resolver's `.input()` and by the panel's form
 * resolver. That is the point. Field-level rendering of `data.zodError` only works if the client
 * knows the same field names the server validated, and it only stays working if there is one
 * schema rather than two that agree today (FR-008, FR-016, FR-122).
 */

/** Identifies one run. The most-used input in the platform. */
export const workflowIdInput = z.object({ workflowId: uuidInput })

/**
 * The launch values a caller may override for a single run.
 *
 * A field the profile has locked is **refused, not silently ignored** — that check needs the
 * profile version, so it lives in the resolver; what this schema fixes is that an override is
 * always a complete, well-typed value rather than free-form text (FR-123).
 */
export const workflowOverridesInput = z.object({
  model: z.enum(CLAUDE_MODELS).optional(),
  instanceType: nonEmptyText.optional(),
  purchaseMode: z.enum(PURCHASE_MODES).optional(),
  turnCap: z.number().int().positive().optional(),
  spendCap: moneyAmount.optional(),
  workflowType: z.enum(WORKFLOW_TYPES).optional(),
})

/**
 * Launch from an execution profile (FR-016, FR-122).
 *
 * `resumeFromSessionId` restores a stored session into a **new** workflow, which FR-016 requires
 * explicitly and US3 depends on. It is a different operation from continuing an existing run by
 * id: the referenced snapshot must be unexpired and within the caller's scope, or the request is
 * refused with the retention limit stated.
 */
export const startWorkflowInput = z.object({
  executionProfileId: uuidInput,
  prompt: nonEmptyText,
  ticketReference: nonEmptyText.optional(),
  overrides: workflowOverridesInput.optional(),
  resumeFromSessionId: uuidInput.optional(),
})

/**
 * A full job spec, launched without a profile (FR-129, FR-187).
 *
 * Admin-only, because it names a bundle version and a workspace version directly and so bypasses
 * the profile that would otherwise have constrained them.
 */
export const startAdHocWorkflowInput = z.object({
  ownerUserId: uuidInput,
  workspaceVersionId: uuidInput,
  setupBundleVersionId: uuidInput,
  workflowType: z.enum(WORKFLOW_TYPES),
  model: z.enum(CLAUDE_MODELS),
  instanceType: nonEmptyText,
  purchaseMode: z.enum(PURCHASE_MODES),
  turnCap: z.number().int().positive().nullish(),
  spendCap: moneyAmount.nullish(),
  prompt: nonEmptyText,
  ticketReference: nonEmptyText.optional(),
})

/**
 * A git remote, entered by hand on the ad hoc launch form.
 *
 * Deliberately loose about the host and deliberately strict about the shape: the platform is not
 * in a position to know which forges an installation uses, but it *is* in a position to know that
 * a value with a space in it, or with no path after the host, is a typo. Catching it here means
 * the form can point at the field, rather than the run failing at `entry_checkout` minutes later
 * having already paid for an instance.
 */
export const repositoryUrlInput = nonEmptyText.regex(
  /^(?:https?:\/\/|ssh:\/\/|git:\/\/|[\w.-]+@)[^\s]+[:/][^\s]+$/,
  'Expected a git remote, such as https://host/org/repo.git or git@host:org/repo.git.',
)

/**
 * Where an ad hoc launch gets its repositories from (FR-129, FR-187).
 *
 * Two branches rather than an optional pair, because "a workspace version **or** a repository" is
 * exactly what the form offers and a shape that admitted both, or neither, would push the decision
 * into the resolver where the type system cannot see it. The `repository` branch is the one-off:
 * the resolver materialises a private, disabled workspace for it, because `workflows`
 * `workspace_version_id` is not null and a run has to be able to say what it checked out (FR-125).
 */
export const adHocWorkspaceInput = z.discriminatedUnion('source', [
  z.object({ source: z.literal('workspace'), workspaceVersionId: uuidInput }),
  z.object({
    source: z.literal('repository'),
    repositoryUrl: repositoryUrlInput,
    baseBranch: nonEmptyText,
  }),
])

/**
 * Saving the entered configuration as a new execution profile (FR-129).
 *
 * Only the naming is asked for. Every launch value the profile would carry has already been
 * entered on the form, so a second copy of them here would be two sources for one configuration
 * and the two would disagree the first time somebody edited one.
 */
export const saveAsProfileInput = z.object({
  name: nonEmptyText.max(120),
  description: nonEmptyText.max(500).optional(),
})

/**
 * The ad hoc launch (FR-016, FR-129, FR-187) — **admin only**.
 *
 * Built from {@link startAdHocWorkflowInput} rather than beside it, so the job-spec half has one
 * definition. What it replaces is the workspace reference, which the form offers two ways, and the
 * owner, which defaults to the admin doing the launching exactly as a profile launch does
 * (FR-132).
 *
 * This is the schema the panel's launch form validates with. One object, two consumers: the
 * resolver's `.input()` and the form. Field-level rendering of `data.zodError` only works while
 * both sides agree on the field names, and two schemas that agree today would not stay agreed.
 */
export const startAdHocInput = startAdHocWorkflowInput
  .omit({ workspaceVersionId: true, ownerUserId: true })
  .extend({
    /** Defaults to the acting admin. A manual run is owned by whoever launched it (FR-132). */
    ownerUserId: uuidInput.optional(),
    workspace: adHocWorkspaceInput,
    /** Present when the admin chose to keep the configuration for next time (FR-129). */
    saveAsProfile: saveAsProfileInput.optional(),
  })

/**
 * The panel's primary read (FR-012, FR-013).
 *
 * Note what is **absent**: there is no "include everything" flag and no owner-less mode. The
 * result set is scoped by `ctx.scope` regardless of what is filtered here, so a filter can only
 * ever narrow what the caller could already see (FR-190).
 */
export const listWorkflowsInput = cursorPagination.extend({
  initiatedByUserId: uuidInput.optional(),
  ownerUserId: uuidInput.optional(),
  originatingIntegrationId: uuidInput.optional(),
  executionProfileId: uuidInput.optional(),
  setupBundleId: uuidInput.optional(),
  workspaceId: uuidInput.optional(),
  repositoryUrl: nonEmptyText.optional(),
  type: z.enum(WORKFLOW_TYPES).optional(),
  state: z.array(z.enum(WORKFLOW_STATES)).min(1).optional(),
  search: nonEmptyText.optional(),
})

/** Incremental log reads: everything from `fromSequence` onward (FR-046). */
export const logSegmentsInput = z.object({
  workflowId: uuidInput,
  fromSequence: z.number().int().nonnegative().default(0),
})

/**
 * Spend aggregation (FR-156, SC-051).
 *
 * Grouping defaults to something other than `user` deliberately: per-user totals are visible to
 * that user and to admins, never as a ranked comparison. The aggregate composes from the same
 * scoped selector as the list, because a total that includes an invisible workflow discloses that
 * it exists (FR-190).
 */
export const spendSummaryInput = dateRange.extend({
  groupBy: z.enum(['client', 'workspace', 'profile', 'user']).default('profile'),
})

/** Mid-run guidance delivered to a running agent (FR-015, FR-049). */
export const correctWorkflowInput = z.object({
  workflowId: uuidInput,
  body: nonEmptyText,
})

/**
 * Continue with changed configuration (FR-150).
 *
 * Creates a **successor** workflow; it never edits the predecessor's job spec (FR-149), which is
 * why the accepted changes are a small closed set rather than the whole spec.
 */
export const continueWithChangesInput = z.object({
  workflowId: uuidInput,
  model: z.enum(CLAUDE_MODELS).optional(),
  turnCap: z.number().int().positive().optional(),
  spendCap: moneyAmount.optional(),
})

/** Hand a run to a different accountable human (FR-134, FR-176). */
export const reassignOwnerInput = z.object({
  workflowId: uuidInput,
  ownerUserId: uuidInput,
})

export type WorkflowIdInput = z.infer<typeof workflowIdInput>
export type WorkflowOverridesInput = z.infer<typeof workflowOverridesInput>
export type StartWorkflowInput = z.infer<typeof startWorkflowInput>
export type StartAdHocWorkflowInput = z.infer<typeof startAdHocWorkflowInput>
export type AdHocWorkspaceInput = z.infer<typeof adHocWorkspaceInput>
export type SaveAsProfileInput = z.infer<typeof saveAsProfileInput>
export type StartAdHocInput = z.infer<typeof startAdHocInput>
export type ListWorkflowsInput = z.infer<typeof listWorkflowsInput>
export type LogSegmentsInput = z.infer<typeof logSegmentsInput>
export type SpendSummaryInput = z.infer<typeof spendSummaryInput>
export type CorrectWorkflowInput = z.infer<typeof correctWorkflowInput>
export type ContinueWithChangesInput = z.infer<typeof continueWithChangesInput>
export type ReassignOwnerInput = z.infer<typeof reassignOwnerInput>
