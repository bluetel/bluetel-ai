import { createProfileInput, LOCKABLE_PROFILE_FIELDS } from '@bluetel-ai/sisyphus-api/client'
import type { LockableProfileField } from '@bluetel-ai/sisyphus-api/client'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import type { RouterInputs } from '@sisyphus-admin/trpc'

import type { ProfileVersionItem } from './profile-listing'

/**
 * The profile editor's values, and the one place they become a request (T082, FR-121, FR-123,
 * FR-125).
 *
 * ## Why the form's state is all strings
 *
 * Because that is what a control holds. A turn cap mid-edit is `''` and then `'4'` and then `'40'`,
 * and a state shaped as `number | null` has to invent an answer for each of those. So the form
 * keeps text and this module is the only place it becomes a request — one conversion to get wrong
 * rather than one per field. The same rule the launch form follows, for the same reason.
 *
 * ## Why it validates with the server's own schema
 *
 * `createProfileInput` is the object the resolver passes to `.input()`. Parsing with it here makes
 * the two sides the same rule rather than two rules that agree today — including `moneyAmount`'s
 * shape and `lockableProfileField`'s closed set, both of which a hand-written check would get
 * subtly wrong.
 *
 * ## Editing loads the version, not the profile
 *
 * {@link draftFromProfileVersion} starts an edit from the immutable version a launch would pin, so
 * publishing version n+1 begins as a copy of version n. Starting from the profile row would be
 * starting from the name and description only — the launch values do not live there.
 */

/** What `admin.profiles.create` accepts. Inferred, never mirrored. */
export type CreateProfileValues = RouterInputs['admin']['profiles']['create']

/** What `admin.profiles.update` accepts. Inferred, never mirrored. */
export type UpdateProfileValues = RouterInputs['admin']['profiles']['update']

/** Everything the profile editor holds, as the controls hold it. */
export interface ProfileDraft {
  readonly name: string
  readonly description: string
  readonly workspaceVersionId: string
  readonly setupBundleVersionId: string
  readonly model: string
  readonly instanceType: string
  readonly purchaseMode: string
  /** Blank means no cap, which is a real answer for a delegated run. */
  readonly turnCap: string
  readonly spendCap: string
  readonly defaultWorkflowType: string
  readonly promptPreamble: string
  /** The fields this version forbids overriding for a single run (FR-123). */
  readonly lockedFields: readonly LockableProfileField[]
}

/** Every field name, for the error map. */
export type ProfileFieldName = keyof ProfileDraft

/** Field-level refusals, keyed by the control they belong under. */
export type ProfileDraftErrors = Partial<Record<ProfileFieldName, FieldErrorContent>>

/**
 * A profile with nothing filled in.
 *
 * Nothing is pre-selected, including the model and the purchase mode. A profile decides what every
 * run on it spends, and a default quietly accepted is a default nobody chose.
 */
export const EMPTY_PROFILE: ProfileDraft = {
  name: '',
  description: '',
  workspaceVersionId: '',
  setupBundleVersionId: '',
  model: '',
  instanceType: '',
  purchaseMode: '',
  turnCap: '',
  spendCap: '',
  defaultWorkflowType: '',
  promptPreamble: '',
  lockedFields: [],
}

/** What to do about each field when it is refused (FR-031). */
const FIELD_ACTIONS: Readonly<Record<ProfileFieldName, string>> = {
  name: 'Name the profile — it is what an engineer chooses on the launch form.',
  description: 'Say what this profile is for, or leave it blank.',
  workspaceVersionId: 'Choose the workspace version this profile pins.',
  setupBundleVersionId: 'Choose the setup bundle version this profile pins.',
  model: 'Choose a model.',
  instanceType: 'Name an instance size, such as m7i.large.',
  purchaseMode: 'Choose interruptible or reserved capacity.',
  turnCap: 'Enter a whole number above zero, or leave it blank for no cap.',
  spendCap: 'Enter an amount such as 25.0000, or leave it blank for no cap.',
  defaultWorkflowType: 'Choose how much a run on this profile may do unattended.',
  promptPreamble: 'Enter the text prepended to every prompt, or leave it blank.',
  lockedFields: 'Lock only fields the platform knows about; unlock the rest.',
}

/** `E_PROFILE_SPEND_CAP` — searchable, stable, and quotable in a ticket. */
export const profileFieldCode = (field: ProfileFieldName): string =>
  `E_PROFILE_${field.replace(/([A-Z])/g, '_$1').toUpperCase()}`

/** The refusal for one field, with its next action. */
export const profileFieldError = (field: ProfileFieldName): FieldErrorContent => ({
  code: profileFieldCode(field),
  action: FIELD_ACTIONS[field],
})

/** Read a zod issue path back to the control it came from, or `undefined` if it is not a field. */
export const profileFieldForIssuePath = (
  path: readonly (string | number)[],
): ProfileFieldName | undefined => {
  const [head] = path
  return typeof head === 'string' && head in EMPTY_PROFILE ? (head as ProfileFieldName) : undefined
}

/** Toggle one lockable field, keeping the list in the platform's own order (FR-123). */
export const withLockedField = (
  locked: readonly LockableProfileField[],
  field: LockableProfileField,
  on: boolean,
): readonly LockableProfileField[] =>
  LOCKABLE_PROFILE_FIELDS.filter((candidate) =>
    candidate === field ? on : locked.includes(candidate),
  )

/**
 * Start an edit from the version a launch would pin (FR-125).
 *
 * @param version - The immutable version. Publishing an edit begins as a copy of it.
 * @param profile - The parent row, which is where the name and description actually live.
 */
export const draftFromProfileVersion = (
  version: ProfileVersionItem,
  profile: { readonly name: string; readonly description: string | null },
): ProfileDraft => ({
  name: profile.name,
  description: profile.description ?? '',
  workspaceVersionId: version.workspaceVersionId,
  setupBundleVersionId: version.setupBundleVersionId,
  model: version.model,
  instanceType: version.instanceType,
  purchaseMode: version.purchaseMode,
  turnCap: version.turnCap === null ? '' : String(version.turnCap),
  spendCap: version.spendCap ?? '',
  defaultWorkflowType: version.defaultWorkflowType,
  promptPreamble: version.promptPreamble ?? '',
  lockedFields: LOCKABLE_PROFILE_FIELDS.filter((field) =>
    (version.lockedFields as readonly string[]).includes(field),
  ),
})

/** A blank optional field is absent, not empty — the two mean different things to the schema. */
const optionalText = (value: string): string | undefined =>
  value.trim() === '' ? undefined : value.trim()

/**
 * A blank cap is `null`, and a filled one is whatever was typed.
 *
 * Text that is not a number becomes `NaN` rather than being dropped, so the schema refuses it and
 * the admin is told. Coercing it would publish an uncapped profile because somebody typed `4o`.
 */
const turnCapValue = (value: string): number | null =>
  value.trim() === '' ? null : Number(value.trim())

/** The candidate request, before validation. Shapes only; every rule is the schema's. */
const toCandidate = (draft: ProfileDraft): unknown => ({
  name: draft.name.trim(),
  description: optionalText(draft.description),
  workspaceVersionId: draft.workspaceVersionId,
  setupBundleVersionId: draft.setupBundleVersionId,
  model: draft.model,
  instanceType: draft.instanceType.trim(),
  purchaseMode: draft.purchaseMode,
  turnCap: turnCapValue(draft.turnCap),
  spendCap: draft.spendCap.trim() === '' ? null : draft.spendCap.trim(),
  defaultWorkflowType: draft.defaultWorkflowType,
  promptPreamble: optionalText(draft.promptPreamble) ?? null,
  lockedFields: [...draft.lockedFields],
})

/** Either the request to send, or where the editor went wrong. */
export type ProfileSubmission =
  | { readonly ok: true; readonly input: CreateProfileValues }
  | { readonly ok: false; readonly errors: ProfileDraftErrors }

/**
 * Turn the editor's values into an `admin.profiles.create` request, or into field errors.
 *
 * @param draft - Everything the controls hold.
 * @returns The parsed input, or a refusal per offending control. Never both, and never neither.
 */
export const toCreateProfileInput = (draft: ProfileDraft): ProfileSubmission => {
  const parsed = createProfileInput.safeParse(toCandidate(draft))

  if (parsed.success) {
    return { ok: true, input: parsed.data }
  }

  const errors: ProfileDraftErrors = {}
  for (const issue of parsed.error.issues) {
    // An issue belonging to no control still has to reach somebody, so it lands on the name — the
    // one field every profile must have.
    const target = profileFieldForIssuePath(issue.path) ?? 'name'
    errors[target] ??= profileFieldError(target)
  }

  return { ok: false, errors }
}

/** Either the update to send, or where the editor went wrong. */
export type ProfileUpdateSubmission =
  | { readonly ok: true; readonly input: UpdateProfileValues }
  | { readonly ok: false; readonly errors: ProfileDraftErrors }

/**
 * The same submission, addressed to an existing profile (FR-125).
 *
 * Built from {@link toCreateProfileInput} rather than beside it, so the two cannot disagree about
 * what a valid profile version is: the difference between publishing version 1 and version n+1 is
 * which id it is addressed to, and nothing else.
 */
export const toUpdateProfileInput = (
  executionProfileId: string,
  draft: ProfileDraft,
): ProfileUpdateSubmission => {
  const submission = toCreateProfileInput(draft)
  if (!submission.ok) return submission

  const { name, description, ...version } = submission.input

  return {
    ok: true,
    input: { executionProfileId, name, description: description ?? null, ...version },
  }
}
