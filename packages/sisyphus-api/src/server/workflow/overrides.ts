import { TRPCError } from '@trpc/server'
import { asc, eq } from 'drizzle-orm'

import type { ExecutionProfileVersion, SisyphusDatabase } from '../../db'
import { profileOverrides } from '../../db'
import type { WorkflowOverridesInput } from '../../schemas'
import type { ScopedReadOptions } from '../scope'
import { requireWorkflowInScope } from '../scope'

import type { OverridableField } from './launch-plan'
import { lockedFieldError, OVERRIDABLE_FIELDS } from './launch-plan'

/**
 * Per-run overrides (FR-123) — the rule, the form's view of it, and the record it leaves behind.
 *
 * ## A locked field is refused, not ignored
 *
 * This is the whole requirement. Silently dropping an override the profile forbids starts a run
 * whose configuration disagrees with what the person who launched it believes they asked for: they
 * chose Opus and a bigger instance, the platform used what the profile said, nothing told them, and
 * the first evidence is the output being wrong or the bill being smaller than the work. A refusal
 * that named nothing is barely better — the launch form has six overridable controls on it and the
 * operator has to guess which one to put back.
 *
 * So {@link assertOverridesPermitted} names every locked field the submission touched, and it names
 * them all at once rather than one refusal per round trip.
 *
 * ## How this relates to `launch-plan.ts`
 *
 * `resolveLaunchPlan` already refuses a locked field while it builds the job spec, and that refusal
 * stays where it is: it is the last line of defence, on the path that actually writes the workflow
 * row, and it must not depend on a caller having remembered to validate first. What it cannot do is
 * report on a submission as a whole — it throws at the first locked field it meets, because by then
 * it is halfway through assembling a spec.
 *
 * This module is the other two thirds of FR-123, which `launch-plan.ts` does not cover and nothing
 * else did:
 *
 * 1. **Validating a submission before anything is built**, reporting every locked field at once, so
 *    the panel can mark every offending control in one pass ({@link assertOverridesPermitted}).
 * 2. **Describing what may be overridden at all**, so the launch form can render a locked field as
 *    locked instead of offering a control whose value will be refused
 *    ({@link describeOverridableFields}). A form that lies to the person filling it in is the same
 *    failure as a silent drop, moved earlier.
 * 3. **Reading the record back** ({@link readProfileOverrides}), which is the second half of FR-123
 *    — "every override MUST be recorded on the workflow alongside the profile it derived from, so a
 *    run's configuration is explicable". The rows are written at launch; until now nothing could
 *    read them, so the record existed and explained nothing.
 *
 * The refusals agree by construction: a single locked field produces the exact message
 * `lockedFieldError` produces, and `overrides.test.ts` asserts that rather than leaving two
 * wordings to drift apart.
 */

/** Every override field, with what the profile says and whether the profile forbids changing it. */
export interface OverridableFieldDescription {
  readonly field: OverridableField
  /** The profile's value, rendered as the panel would show it. `null` where the profile sets none. */
  readonly profileValue: string | null
  /** `true` when an override of this field is refused (FR-123). */
  readonly locked: boolean
}

/** Render a profile value the way the record does. `null` stays null; everything else is text. */
const asDisplayValue = (value: string | number | null): string | null =>
  value === null ? null : String(value)

/**
 * The profile version's launch values, keyed by the field name an override uses.
 *
 * `workflowType` is the one name that differs on the two sides — the column is
 * `default_workflow_type` and the override is `workflowType` — so the mapping is stated once here
 * rather than being re-derived by every caller that has to line the two up.
 */
const profileValuesByField = (
  profileVersion: ExecutionProfileVersion,
): Record<OverridableField, string | number | null> => ({
  model: profileVersion.model,
  instanceType: profileVersion.instanceType,
  purchaseMode: profileVersion.purchaseMode,
  turnCap: profileVersion.turnCap,
  spendCap: profileVersion.spendCap,
  workflowType: profileVersion.defaultWorkflowType,
})

/**
 * Describe every overridable field for the launch form (FR-122, FR-123).
 *
 * Returned in {@link OVERRIDABLE_FIELDS} order, always complete: a run is startable with nothing
 * but a prompt, so the form's job is to show what it is about to use, and a field missing from this
 * list would be a value the run uses and the operator never saw.
 */
export const describeOverridableFields = (
  profileVersion: ExecutionProfileVersion,
): readonly OverridableFieldDescription[] => {
  const values = profileValuesByField(profileVersion)
  const locked = new Set(profileVersion.lockedFields)

  return OVERRIDABLE_FIELDS.map((field) => ({
    field,
    profileValue: asDisplayValue(values[field]),
    locked: locked.has(field),
  }))
}

/**
 * The fields this submission tried to override that the profile forbids (FR-123).
 *
 * A field the caller did not supply is not an attempt, and a field whose submitted value equals the
 * profile's own is not one either — the launch form prefills every value (FR-122), so it submits
 * the profile's own numbers far more often than it submits changes, and refusing those would make a
 * locked profile impossible to launch from its own form.
 *
 * Returned in `OVERRIDABLE_FIELDS` order so the message is stable rather than dependent on the
 * order the caller happened to serialise its object in.
 */
export const lockedOverrideFields = (
  profileVersion: ExecutionProfileVersion,
  overrides: WorkflowOverridesInput | undefined,
): readonly OverridableField[] => {
  if (overrides === undefined) {
    return []
  }

  const values = profileValuesByField(profileVersion)
  const locked = new Set(profileVersion.lockedFields)

  return OVERRIDABLE_FIELDS.filter((field) => {
    if (!locked.has(field)) {
      return false
    }

    const requested = overrides[field]
    return requested !== undefined && requested !== values[field]
  })
}

/**
 * Refusal naming every locked field the submission touched (FR-123).
 *
 * `BAD_REQUEST` rather than `FORBIDDEN`, for the reason `lockedFieldError` is: the caller is
 * entitled to launch on this profile — they hold it — and what is wrong is the request, not their
 * authority.
 *
 * For a single field this produces exactly the message `lockedFieldError` produces, so the
 * pre-flight refusal and the one `resolveLaunchPlan` raises are the same sentence rather than two
 * wordings of one rule.
 */
export const lockedOverridesError = (fields: readonly OverridableField[]): TRPCError => {
  const [only] = fields
  if (fields.length === 1) {
    return lockedFieldError(only)
  }

  const named = fields.join(', ')
  return new TRPCError({
    code: 'BAD_REQUEST',
    message: `The execution profile locks ${named}, so they cannot be overridden for a single run.`,
  })
}

/**
 * Refuse a submission that overrides a locked field, naming every one of them (FR-123).
 *
 * @param profileVersion - The immutable version the run would pin. `lockedFields` is read from
 *   here rather than from the mutable profile row, so a lock added after this run was configured
 *   does not retroactively refuse it (FR-125).
 * @param overrides - The caller's deviations, or `undefined` for the prefilled path (FR-122).
 * @throws {@link lockedOverridesError} listing every locked field the caller tried to change.
 */
export const assertOverridesPermitted = (
  profileVersion: ExecutionProfileVersion,
  overrides: WorkflowOverridesInput | undefined,
): void => {
  const locked = lockedOverrideFields(profileVersion, overrides)
  if (locked.length > 0) {
    throw lockedOverridesError(locked)
  }
}

/** Anything that can run this module's statements — the pooled handle or a transaction on it. */
export type OverrideReader = Pick<SisyphusDatabase, 'select'>

/**
 * One recorded deviation, as the run's detail view explains it.
 *
 * Both values are kept, because "this run used m7i.4xlarge" is not an explanation on its own but
 * "the profile said m7i.large and this run used m7i.4xlarge, set by Ada" is.
 */
export interface RecordedOverride {
  readonly field: string
  readonly profileValue: string | null
  readonly usedValue: string
  readonly setByUserId: string
  readonly createdAt: Date
}

/**
 * Read the deviations recorded against one run (FR-123, FR-065).
 *
 * **Takes a workflow id the caller has already scoped.** Use {@link readProfileOverridesInScope}
 * from a resolver; this one exists for callers that already hold the row — the control plane's
 * in-process caller, and the detail read that fetched the workflow a moment earlier.
 */
export const readProfileOverrides = async (
  reader: OverrideReader,
  workflowId: string,
): Promise<readonly RecordedOverride[]> =>
  reader
    .select({
      field: profileOverrides.field,
      profileValue: profileOverrides.profileValue,
      usedValue: profileOverrides.usedValue,
      setByUserId: profileOverrides.setByUserId,
      createdAt: profileOverrides.createdAt,
    })
    .from(profileOverrides)
    .where(eq(profileOverrides.workflowId, workflowId))
    .orderBy(asc(profileOverrides.field))

/**
 * Read one run's deviations, scoped (FR-190).
 *
 * The workflow is resolved through the one base selector first, so a run outside the caller's scope
 * comes back as the ordinary `NOT_FOUND` rather than as an empty override list — an empty list is
 * an answer, and answering "that run changed nothing" about a run whose existence the caller was
 * not entitled to learn is the disclosure FR-190 prohibits.
 */
export const readProfileOverridesInScope = async (
  options: ScopedReadOptions & { readonly workflowId: string },
): Promise<readonly RecordedOverride[]> => {
  const workflow = await requireWorkflowInScope(options)
  return readProfileOverrides(options.db, workflow.id)
}
