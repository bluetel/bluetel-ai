/* cspell:ignore startable */
import { TRPCError } from '@trpc/server'

import type { ExecutionProfileVersion } from '../../db'
import type { ClaudeModel, PurchaseMode, WorkflowType } from '../../enums'
import type { WorkflowOverridesInput } from '../../schemas'

/**
 * Turning an execution profile version plus a caller's overrides into the job spec a workflow row
 * is written from (FR-122, FR-123).
 *
 * Pure: no database handle, no context, no clock. That is the point — the rule that decides which
 * configuration a run actually gets is the rule most worth being able to test exhaustively, and a
 * function that needed a transaction to answer would be tested once and by accident.
 *
 * Two properties are load-bearing.
 *
 * 1. **A run is startable with nothing but a prompt (FR-122).** Every value comes from the profile
 *    version unless the caller replaced it, so the launch form's "select a profile, type, go" path
 *    reaches here with an empty override set and still produces a complete spec.
 * 2. **A locked field is refused, never ignored (FR-123).** Silently dropping the override would
 *    start a run whose configuration disagrees with what the person who launched it believes they
 *    asked for — and they would find out from the bill.
 */

/** The override fields a caller may name. Exactly the keys of `workflowOverridesInput`. */
export const OVERRIDABLE_FIELDS = [
  'model',
  'instanceType',
  'purchaseMode',
  'turnCap',
  'spendCap',
  'workflowType',
] as const

export type OverridableField = (typeof OVERRIDABLE_FIELDS)[number]

/**
 * One recorded deviation from the profile (FR-123).
 *
 * Both values are kept: "this run used `m7i.4xlarge`" is not explicable on its own, but "the
 * profile said `m7i.large` and this run used `m7i.4xlarge`" is.
 */
export interface AppliedOverride {
  readonly field: OverridableField
  readonly profileValue: string | null
  readonly usedValue: string
}

/** The job spec a workflow row is written from. */
export interface LaunchPlan {
  readonly workflowType: WorkflowType
  readonly model: ClaudeModel
  readonly instanceType: string
  readonly purchaseMode: PurchaseMode
  readonly turnCap: number | null
  readonly spendCap: string | null
  readonly workspaceVersionId: string
  readonly setupBundleVersionId: string
  readonly executionProfileVersionId: string
  readonly overrides: readonly AppliedOverride[]
}

/**
 * Refusal for an override the profile forbids (FR-123).
 *
 * `BAD_REQUEST` rather than `FORBIDDEN`: the caller is entitled to launch on this profile — they
 * hold it — and what is wrong is the request, not their authority. The field is named because it
 * is the caller's own input and the panel has to be able to say which control to put back.
 */
export const lockedFieldError = (field: OverridableField): TRPCError =>
  new TRPCError({
    code: 'BAD_REQUEST',
    message: `The execution profile locks ${field}, so it cannot be overridden for a single run.`,
  })

/** Render a profile value for the audit row. `null` stays null; everything else is text. */
const asRecordedValue = (value: string | number | null): string | null =>
  value === null ? null : String(value)

/**
 * Apply one override, or leave the profile's value in place.
 *
 * Returns the value to use and — when the caller supplied one — the record of the deviation.
 */
const applyOverride = <TValue extends string | number | null>(options: {
  readonly field: OverridableField
  readonly lockedFields: readonly string[]
  readonly profileValue: TValue
  readonly requested: TValue | undefined
}): { readonly value: TValue; readonly override: AppliedOverride | undefined } => {
  const { field, lockedFields, profileValue, requested } = options

  if (requested === undefined) {
    return { value: profileValue, override: undefined }
  }

  if (lockedFields.includes(field)) {
    throw lockedFieldError(field)
  }

  // An "override" that restates the profile's own value is not a deviation and is not recorded —
  // the launch form prefills every field (FR-122), so it submits values that match far more often
  // than it submits changes, and a trail padded with non-events is harder to read.
  if (requested === profileValue) {
    return { value: profileValue, override: undefined }
  }

  return {
    value: requested,
    override: {
      field,
      profileValue: asRecordedValue(profileValue),
      usedValue: String(requested),
    },
  }
}

/**
 * Build the job spec for one run.
 *
 * @param profileVersion - The immutable version the run pins. Everything it needs is on here
 *   rather than on the mutable profile row, which is what lets an edit mid-flight leave this run
 *   alone (FR-125, FR-149).
 * @param overrides - Per-run deviations, or `undefined` for the prefilled path (FR-122).
 * @throws A `BAD_REQUEST` naming the first locked field the caller tried to override (FR-123).
 */
export const resolveLaunchPlan = (
  profileVersion: ExecutionProfileVersion,
  overrides: WorkflowOverridesInput | undefined,
): LaunchPlan => {
  const lockedFields = profileVersion.lockedFields
  const applied: AppliedOverride[] = []

  const take = <TValue extends string | number | null>(
    field: OverridableField,
    profileValue: TValue,
    requested: TValue | undefined,
  ): TValue => {
    const result = applyOverride({ field, lockedFields, profileValue, requested })
    if (result.override !== undefined) {
      applied.push(result.override)
    }
    return result.value
  }

  const workflowType = take(
    'workflowType',
    profileVersion.defaultWorkflowType,
    overrides?.workflowType,
  )
  const model = take('model', profileVersion.model, overrides?.model)
  const instanceType = take('instanceType', profileVersion.instanceType, overrides?.instanceType)
  const purchaseMode = take('purchaseMode', profileVersion.purchaseMode, overrides?.purchaseMode)
  const turnCap = take('turnCap', profileVersion.turnCap, overrides?.turnCap)
  const spendCap = take('spendCap', profileVersion.spendCap, overrides?.spendCap)

  return {
    workflowType,
    model,
    instanceType,
    purchaseMode,
    turnCap,
    spendCap,
    workspaceVersionId: profileVersion.workspaceVersionId,
    setupBundleVersionId: profileVersion.setupBundleVersionId,
    executionProfileVersionId: profileVersion.id,
    overrides: applied,
  }
}
