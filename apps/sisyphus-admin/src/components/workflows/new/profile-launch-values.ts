import { startWorkflowInput } from '@bluetel-ai/sisyphus-api/client'
import type { LockableProfileField } from '@bluetel-ai/sisyphus-api/client'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import type { RouterInputs } from '@sisyphus-admin/trpc'

import type { LaunchFieldName, LaunchFormValues } from './launch-form-values'
import { describeLaunchFieldLocks, lockedFieldRefusals } from './profile-locks'
import type { LaunchProfile, LaunchProfileVersion } from './profile-prefill'

/**
 * Turning the prefilled form into a `workflow.start` request (T080, FR-016, FR-122, FR-123).
 *
 * ## An override is a field that differs, not a field that was touched
 *
 * The form prefills every value from the profile (FR-122), so almost every submission carries the
 * profile's own numbers back. Sending them as `overrides` would record a deviation on every run —
 * FR-123 asks for overrides to be recorded "so a run's configuration is explicable", and a record
 * that says every field was overridden to the value it already had explains nothing. So the
 * override set is computed by comparison: a field is an override exactly when what the control
 * holds differs from what the profile version says.
 *
 * ## Why it validates with the server's own schema
 *
 * `startWorkflowInput` is the object the resolver passes to `.input()`, for the same reason
 * `toStartAdHocInput` uses `startAdHocInput`: it makes the two sides *the same rule* rather than
 * two rules that agree today.
 *
 * ## The one thing the contract cannot express
 *
 * `workflowOverridesInput` has no null: a cap can be overridden to a different number, never to
 * "no cap". So blanking a cap the profile sets is refused here, naming the field, rather than
 * silently launching under the profile's cap while the control on screen says otherwise.
 *
 * ## `resumeFromSessionId` is not a launch value
 *
 * It is carried separately rather than on {@link LaunchFormValues}, because it is not part of the
 * configuration a profile prefills — it names a stored session to restore **into a new workflow**,
 * which FR-016 is explicit is a different operation from continuing an existing run by its id.
 * Folding it into the values object would put it alongside the model and the caps, which is exactly
 * the conflation the requirement warns against.
 */

/** What `workflow.start` accepts. Inferred, never mirrored. */
export type StartWorkflowValues = RouterInputs['workflow']['start']

/** Everything the profile path can put an error under. */
export type ProfileLaunchFieldName = LaunchFieldName | 'executionProfileId' | 'resumeFromSessionId'

/** Field-level refusals, keyed by the control they belong under. */
export type ProfileLaunchErrors = Partial<Record<ProfileLaunchFieldName, FieldErrorContent>>

/** Everything the profile path holds outside {@link LaunchFormValues}. */
export interface ProfileLaunchExtras {
  /** A stored session to restore into a **new** workflow (FR-016). Blank when starting fresh. */
  readonly resumeFromSessionId: string
}

/** What to do about each field the profile path can refuse. */
const PROFILE_FIELD_ACTIONS: Readonly<Record<ProfileLaunchFieldName, string>> = {
  executionProfileId: 'Choose an execution profile from the list.',
  resumeFromSessionId:
    'Paste the session id of the run you are restoring, or leave it blank to start fresh.',
  workspaceSource: 'Choose an execution profile — it decides what the run checks out.',
  workspaceVersionId: 'Choose an execution profile — it pins the workspace version.',
  repositoryUrl: 'Choose an execution profile — it pins the repositories.',
  baseBranch: 'Choose an execution profile — it pins the base branches.',
  workflowType: 'Choose how much the agent may do unattended.',
  model: 'Choose a model.',
  instanceType: 'Name an instance size, such as m7i.large.',
  purchaseMode: 'Choose interruptible or reserved capacity.',
  turnCap: 'Enter a whole number above zero. This profile sets a cap, so it cannot be cleared.',
  spendCap: 'Enter an amount such as 25.0000. This profile sets a cap, so it cannot be cleared.',
  setupBundleVersionId: 'Choose an execution profile — it pins the setup bundle version.',
  ticketReference: 'Enter a ticket reference, or leave it blank.',
  prompt: 'Say what the agent should do.',
  saveAsProfileName: 'Saving a profile is part of the ad hoc path, not this one.',
}

/** `E_LAUNCH_RESUME_FROM_SESSION_ID` — searchable, stable, and quotable in a ticket. */
export const profileFieldCode = (field: ProfileLaunchFieldName): string =>
  `E_LAUNCH_${field.replace(/([A-Z])/g, '_$1').toUpperCase()}`

/** The refusal for one field, with the next action written for the profile path. */
export const profileFieldError = (field: ProfileLaunchFieldName): FieldErrorContent => ({
  code: profileFieldCode(field),
  action: PROFILE_FIELD_ACTIONS[field],
})

/** Where a `startWorkflowInput` issue path lands on the form. Overrides are the nested branch. */
const FIELD_FOR_PATH: Readonly<Partial<Record<string, ProfileLaunchFieldName>>> = {
  executionProfileId: 'executionProfileId',
  prompt: 'prompt',
  ticketReference: 'ticketReference',
  resumeFromSessionId: 'resumeFromSessionId',
  'overrides.model': 'model',
  'overrides.instanceType': 'instanceType',
  'overrides.purchaseMode': 'purchaseMode',
  'overrides.turnCap': 'turnCap',
  'overrides.spendCap': 'spendCap',
  'overrides.workflowType': 'workflowType',
}

/** Read a zod issue path back to the control it came from, or `undefined` if it is not a field. */
export const profileFieldForIssuePath = (
  path: readonly (string | number)[],
): ProfileLaunchFieldName | undefined => FIELD_FOR_PATH[path.join('.')]

/** A blank optional field is absent, not empty — the two mean different things to the schema. */
const optionalText = (value: string): string | undefined =>
  value.trim() === '' ? undefined : value.trim()

/**
 * One override's value, typed as the schema wants it.
 *
 * Text that is not a number becomes `NaN` rather than being dropped, so the schema refuses it and
 * the operator is told — the same rule the ad hoc form follows, and for the same reason: coercing
 * it would quietly launch under a cap nobody chose because somebody typed `4o`.
 */
const overrideValue = (field: LockableProfileField, text: string): unknown =>
  field === 'turnCap' ? Number(text.trim()) : text.trim()

/** The deviations from the profile, and the caps this run tried to clear and may not. */
interface OverrideReading {
  readonly overrides: Record<string, unknown>
  readonly cleared: readonly LaunchFieldName[]
}

/**
 * Read the form against the profile version, field by field.
 *
 * Locked fields are excluded from the comparison entirely: {@link lockedFieldRefusals} has already
 * reported them, and including one here would send an override the server would refuse a second
 * time with a message the form could no longer point at a control.
 */
const readOverrides = (
  version: LaunchProfileVersion,
  values: LaunchFormValues,
): OverrideReading => {
  const overrides: Record<string, unknown> = {}
  const cleared: LaunchFieldName[] = []

  for (const lock of describeLaunchFieldLocks(version)) {
    if (lock.locked) continue

    const held = values[lock.control].trim()
    if (held === lock.profileValue.trim()) continue

    // The contract has no "no cap" override, so clearing a cap the profile sets is not a request
    // that can be made. Refused by name rather than dropped.
    if (held === '') {
      cleared.push(lock.control)
      continue
    }

    overrides[lock.field] = overrideValue(lock.field, held)
  }

  return { overrides, cleared }
}

/** Either the request to send, or where the form went wrong. */
export type ProfileLaunchSubmission =
  | { readonly ok: true; readonly input: StartWorkflowValues }
  | { readonly ok: false; readonly errors: ProfileLaunchErrors }

/**
 * Turn the prefilled form into a `workflow.start` request, or into field errors.
 *
 * @param profile - The chosen profile, or `undefined` when nothing is chosen yet.
 * @param values - Everything the launch controls hold.
 * @param extras - The session reference, which is not a launch value.
 * @returns The parsed input, or a refusal per offending control. Never both, and never neither —
 *   a submission that produced no request and no error would leave the button dead.
 */
export const toStartWorkflowInput = (
  profile: LaunchProfile | undefined,
  values: LaunchFormValues,
  extras: ProfileLaunchExtras,
): ProfileLaunchSubmission => {
  const version = profile?.currentVersion
  if (profile === undefined || version === undefined) {
    return { ok: false, errors: { executionProfileId: profileFieldError('executionProfileId') } }
  }

  const locked = lockedFieldRefusals(version, values)
  const { overrides, cleared } = readOverrides(version, values)

  if (Object.keys(locked).length > 0 || cleared.length > 0) {
    const errors: ProfileLaunchErrors = { ...locked }
    for (const field of cleared) {
      errors[field] ??= profileFieldError(field)
    }
    return { ok: false, errors }
  }

  // Each optional key is spread in only when it has a value. A key present and `undefined` is not
  // the same as a key that is absent — it survives into the parsed output, and the request then
  // says "no session" where it should have said nothing about sessions at all.
  const ticketReference = optionalText(values.ticketReference)
  const resumeFromSessionId = optionalText(extras.resumeFromSessionId)

  const parsed = startWorkflowInput.safeParse({
    executionProfileId: profile.id,
    prompt: values.prompt,
    ...(ticketReference === undefined ? {} : { ticketReference }),
    ...(resumeFromSessionId === undefined ? {} : { resumeFromSessionId }),
    ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
  })

  if (parsed.success) {
    return { ok: true, input: parsed.data }
  }

  const errors: ProfileLaunchErrors = {}
  for (const issue of parsed.error.issues) {
    // An issue belonging to no control still has to reach somebody, so it lands on the prompt —
    // the only field on this path the operator is required to supply.
    const target = profileFieldForIssuePath(issue.path) ?? 'prompt'
    errors[target] ??= profileFieldError(target)
  }

  return { ok: false, errors }
}
