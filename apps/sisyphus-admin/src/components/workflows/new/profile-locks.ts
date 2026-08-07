import { LOCKABLE_PROFILE_FIELDS } from '@bluetel-ai/sisyphus-api/client'
import type { LockableProfileField } from '@bluetel-ai/sisyphus-api/client'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'

import type { LaunchFieldName, LaunchFormValues } from './launch-form-values'
import type { LaunchProfileVersion } from './profile-prefill'

/**
 * Which prefilled values this run may change, and what the form does about the ones it may not
 * (T080, FR-123).
 *
 * ## A locked field is shown as locked
 *
 * `describeOverridableFields` exists on the server *specifically* so this screen can render a
 * locked control as locked. There are three things the form could do with a field the profile
 * forbids changing, and two of them are defects:
 *
 * 1. **Hide it.** The run still uses the value, so the operator is now spending money on a
 *    configuration they were never shown. FR-122 asks for every value to be prefilled; a hidden
 *    field is one nobody was shown that happens to look tidy.
 * 2. **Offer an editable control and drop the change.** This is the exact failure FR-123 was
 *    written against, moved from the resolver into the browser: they chose a bigger instance, the
 *    platform used the profile's, and nothing said so.
 * 3. **Show the value, disabled, and say who fixed it.** What this module supports.
 *
 * The refusal in {@link lockedFieldRefusals} is the belt to that braces. A disabled control cannot
 * normally be changed, but a value can still differ from the profile's — a profile edited to lock a
 * field the operator had already overridden, a stale prefill, a hand-crafted request — and in that
 * case the submission is **refused naming the field** rather than sent and refused by the server,
 * or worse, sent with the deviation silently dropped.
 *
 * ## Why the two field vocabularies are mapped here
 *
 * `LOCKABLE_PROFILE_FIELDS` is the platform's closed set; {@link LaunchFieldName} is what the
 * controls are keyed by. They agree on all six names today, and this map is what makes that an
 * assertion rather than a coincidence — the `satisfies` clause fails to compile the day either side
 * renames one.
 */

/** Every field a profile may lock, keyed to the control it belongs to on the launch form. */
export const LOCKABLE_FIELD_CONTROLS = {
  model: 'model',
  instanceType: 'instanceType',
  purchaseMode: 'purchaseMode',
  turnCap: 'turnCap',
  spendCap: 'spendCap',
  workflowType: 'workflowType',
} as const satisfies Record<LockableProfileField, LaunchFieldName>

/** The lockable fields as a list, in the platform's own order, so a message is stable. */
export const LOCKABLE_FIELD_NAMES: readonly LockableProfileField[] = LOCKABLE_PROFILE_FIELDS

/** What each locked field is called on screen. Sentence case: these are captions, not readouts. */
const LOCKED_FIELD_LABELS: Readonly<Record<LockableProfileField, string>> = {
  model: 'Model',
  instanceType: 'Instance size',
  purchaseMode: 'Capacity',
  turnCap: 'Turn cap',
  spendCap: 'Spend cap',
  workflowType: 'Workflow type',
}

/**
 * Read one lockable field's value off the form, as text.
 *
 * Every launch control holds a string — see `launch-form-values.ts` for why — so the comparison
 * against the profile is a text comparison and needs no per-field parsing.
 */
const controlValue = (values: LaunchFormValues, field: LockableProfileField): string =>
  values[LOCKABLE_FIELD_CONTROLS[field]]

/** The profile's value for one lockable field, as the form would hold it. */
const profileValue = (version: LaunchProfileVersion, field: LockableProfileField): string => {
  switch (field) {
    case 'model':
      return version.model
    case 'instanceType':
      return version.instanceType
    case 'purchaseMode':
      return version.purchaseMode
    case 'turnCap':
      return version.turnCap === null ? '' : String(version.turnCap)
    case 'spendCap':
      return version.spendCap ?? ''
    case 'workflowType':
      return version.defaultWorkflowType
  }
}

/** A lockable field, with what the profile says and whether this run may change it. */
export interface LaunchFieldLock {
  readonly field: LockableProfileField
  /** The control this belongs to, so a caller keys errors and props without re-deriving it. */
  readonly control: LaunchFieldName
  readonly label: string
  /** The profile's own value, as the form holds it. Blank for a cap the profile does not set. */
  readonly profileValue: string
  readonly locked: boolean
}

/**
 * Describe every lockable field for the launch form (FR-122, FR-123).
 *
 * Complete and in the platform's order, mirroring `describeOverridableFields` on the server: a
 * field missing from this list would be a value the run uses and the form never mentioned.
 *
 * @param version - The immutable version the run would pin. `lockedFields` is read from the
 *   version rather than the profile row, so a lock added after this form was prefilled is what the
 *   *next* prefill sees rather than something that retroactively refuses this one.
 */
export const describeLaunchFieldLocks = (
  version: LaunchProfileVersion,
): readonly LaunchFieldLock[] => {
  const locked = new Set<string>(version.lockedFields)

  return LOCKABLE_FIELD_NAMES.map((field) => ({
    field,
    control: LOCKABLE_FIELD_CONTROLS[field],
    label: LOCKED_FIELD_LABELS[field],
    profileValue: profileValue(version, field),
    locked: locked.has(field),
  }))
}

/** Just the controls a locked profile forbids editing, for a caller that only needs the set. */
export const lockedLaunchControls = (version: LaunchProfileVersion): ReadonlySet<LaunchFieldName> =>
  new Set(
    describeLaunchFieldLocks(version)
      .filter((lock) => lock.locked)
      .map((lock) => lock.control),
  )

/** `E_LAUNCH_LOCKED_SPEND_CAP` — searchable, stable, and quotable in a ticket. */
export const lockedFieldCode = (field: LockableProfileField): string =>
  `E_LAUNCH_LOCKED_${field.replace(/([A-Z])/g, '_$1').toUpperCase()}`

/**
 * The refusals for every locked field this submission would have changed (FR-123).
 *
 * Keyed by control so the panel can mark each offending field in one pass rather than one refusal
 * per round trip — the same "name them all at once" rule `assertOverridesPermitted` follows on the
 * server, applied before the request is built.
 *
 * A field whose value merely *equals* the profile's is not an attempt to change it. The form
 * prefills every value, so it holds the profile's own numbers far more often than it holds a
 * deviation, and treating equality as an override would make a locked profile impossible to launch
 * from its own form.
 */
export const lockedFieldRefusals = (
  version: LaunchProfileVersion,
  values: LaunchFormValues,
): Partial<Record<LaunchFieldName, FieldErrorContent>> => {
  const refusals: Partial<Record<LaunchFieldName, FieldErrorContent>> = {}

  for (const lock of describeLaunchFieldLocks(version)) {
    if (!lock.locked || controlValue(values, lock.field) === lock.profileValue) {
      continue
    }

    refusals[lock.control] = {
      code: lockedFieldCode(lock.field),
      action: `This profile fixes ${lock.label.toLowerCase()}. Launch with the profile's value, or ask an admin for a profile that leaves it open.`,
    }
  }

  return refusals
}
