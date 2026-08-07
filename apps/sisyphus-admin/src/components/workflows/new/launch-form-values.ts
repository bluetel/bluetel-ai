import { startAdHocInput } from '@bluetel-ai/sisyphus-api/client'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import type { RouterInputs } from '@sisyphus-admin/trpc'

/**
 * The launch form's values, and the one place they become a request (T064a, FR-008, FR-016).
 *
 * ## Why the form's state is all strings
 *
 * Because that is what a control holds. A turn cap mid-edit is `''` and then `'4'` and then
 * `'40'`, and a state shaped as `number | null` has to invent an answer for each of those. So the
 * form keeps text, and **this module is the only place it is turned into a request** — which means
 * there is exactly one conversion to get wrong rather than one per field.
 *
 * ## Why it validates with the server's own schema
 *
 * `startAdHocInput` is the object the resolver passes to `.input()`. Parsing with it here is not
 * belt-and-braces: it is what makes the two sides *the same rule*. A form with its own idea of a
 * valid remote URL or a valid spend cap would agree with the server on the day it was written and
 * quietly stop agreeing the first time either was tightened, and the failure would be a refusal
 * the form could not point at a field.
 *
 * ## The seam for the profile-first path (T080)
 *
 * {@link LaunchFormValues} is deliberately the *whole* launch configuration rather than "the ad hoc
 * fields", because FR-122 says selecting a profile prefills exactly these values and leaves the
 * prompt as the only required input. So T080's path is `setValues(fromProfile(profile))` on this
 * same object plus a different mutation — not a second form. Nothing here knows which procedure
 * the values are destined for.
 */

/** What `workflow.startAdHoc` accepts. Inferred, never mirrored. */
export type StartAdHocValues = RouterInputs['workflow']['startAdHoc']

/** Every control on the launch form, as the control holds it. */
export interface LaunchFormValues {
  /** Which of the two answers to "what does this run check out". */
  readonly workspaceSource: 'workspace' | 'repository'
  readonly workspaceVersionId: string
  readonly repositoryUrl: string
  readonly baseBranch: string
  readonly workflowType: string
  readonly model: string
  readonly instanceType: string
  readonly purchaseMode: string
  /** Blank means no cap, which is a real answer for a delegated run. */
  readonly turnCap: string
  readonly spendCap: string
  readonly setupBundleVersionId: string
  readonly ticketReference: string
  readonly prompt: string
  /**
   * Naming a profile is what saves one (FR-129). There is no separate checkbox, and that is the
   * point: a checkbox and a name are two controls that can disagree, and the disagreement is
   * silent — a ticked box with an empty name saves nothing and says it saved something.
   */
  readonly saveAsProfileName: string
}

/** Every field name, for the error map and for the field tables. */
export type LaunchFieldName = keyof LaunchFormValues

/** Field-level refusals, keyed by the control they belong under. */
export type LaunchFieldErrors = Partial<Record<LaunchFieldName, FieldErrorContent>>

/**
 * A form with nothing filled in.
 *
 * Nothing is pre-selected, including the model and the purchase mode. A launch spends money on
 * somebody's behalf, and a default quietly accepted is a default nobody chose.
 */
export const EMPTY_LAUNCH_FORM: LaunchFormValues = {
  workspaceSource: 'workspace',
  workspaceVersionId: '',
  repositoryUrl: '',
  baseBranch: '',
  workflowType: '',
  model: '',
  instanceType: '',
  purchaseMode: '',
  turnCap: '',
  spendCap: '',
  setupBundleVersionId: '',
  ticketReference: '',
  prompt: '',
  saveAsProfileName: '',
}

/**
 * What to do about each field when it is refused (FR-031).
 *
 * A next action per field rather than the validator's own message. Zod says "String must contain
 * at least 1 character(s)", which describes the failure; an operator needs the sentence that says
 * what to type instead.
 */
const FIELD_ACTIONS: Readonly<Record<LaunchFieldName, string>> = {
  workspaceSource: 'Choose a workspace, or enter a repository and a branch.',
  workspaceVersionId: 'Pick a workspace from the list.',
  repositoryUrl: 'Enter a git remote, such as git@host:org/repo.git.',
  baseBranch: 'Name the branch the run should start from.',
  workflowType: 'Choose how much the agent may do unattended.',
  model: 'Choose a model.',
  instanceType: 'Name an instance size, such as m7i.large.',
  purchaseMode: 'Choose interruptible or reserved capacity.',
  turnCap: 'Enter a whole number above zero, or leave it blank for no cap.',
  spendCap: 'Enter an amount such as 25.0000, or leave it blank for no cap.',
  setupBundleVersionId: 'Pick an enabled setup bundle.',
  ticketReference: 'Enter a ticket reference, or leave it blank.',
  prompt: 'Say what the agent should do.',
  saveAsProfileName: 'Name the profile, or leave it blank to launch without saving one.',
}

/** Where a schema path lands on the form. The workspace branch is nested; nothing else is. */
const FIELD_FOR_PATH: Readonly<Partial<Record<string, LaunchFieldName>>> = {
  workspace: 'workspaceSource',
  'workspace.workspaceVersionId': 'workspaceVersionId',
  'workspace.repositoryUrl': 'repositoryUrl',
  'workspace.baseBranch': 'baseBranch',
  'saveAsProfile.name': 'saveAsProfileName',
  'saveAsProfile.description': 'saveAsProfileName',
}

/** `E_LAUNCH_SPEND_CAP` — searchable, stable, and quotable in a ticket. */
const codeFor = (field: LaunchFieldName): string =>
  `E_LAUNCH_${field.replace(/([A-Z])/g, '_$1').toUpperCase()}`

/** Read a zod issue path back to the control it came from, or `undefined` if it is not a field. */
export const fieldForIssuePath = (
  path: readonly (string | number)[],
): LaunchFieldName | undefined => {
  const joined = path.join('.')
  const nested = FIELD_FOR_PATH[joined]
  if (nested !== undefined) return nested

  return joined in EMPTY_LAUNCH_FORM ? (joined as LaunchFieldName) : undefined
}

/** A blank optional field is absent, not empty — the two mean different things to the schema. */
const optionalText = (value: string): string | undefined =>
  value.trim() === '' ? undefined : value.trim()

/**
 * A blank cap is `null`, and a filled one is whatever was typed.
 *
 * Text that is not a number becomes `NaN` rather than being dropped, so the schema refuses it and
 * the operator is told. Coercing it to `null` would silently launch an uncapped run because
 * somebody typed `4o`.
 */
const turnCapValue = (value: string): number | null =>
  value.trim() === '' ? null : Number(value.trim())

/** The candidate request, before validation. Shapes only; every rule is the schema's. */
const toCandidate = (values: LaunchFormValues): unknown => ({
  workspace:
    values.workspaceSource === 'repository'
      ? {
          source: 'repository',
          repositoryUrl: values.repositoryUrl.trim(),
          baseBranch: values.baseBranch.trim(),
        }
      : { source: 'workspace', workspaceVersionId: values.workspaceVersionId },
  setupBundleVersionId: values.setupBundleVersionId,
  workflowType: values.workflowType,
  model: values.model,
  instanceType: values.instanceType.trim(),
  purchaseMode: values.purchaseMode,
  turnCap: turnCapValue(values.turnCap),
  spendCap: values.spendCap.trim() === '' ? null : values.spendCap.trim(),
  prompt: values.prompt,
  ticketReference: optionalText(values.ticketReference),
  saveAsProfile:
    values.saveAsProfileName.trim() === '' ? undefined : { name: values.saveAsProfileName.trim() },
})

/** Either the request to send, or where the form went wrong. */
export type LaunchSubmission =
  | { readonly ok: true; readonly input: StartAdHocValues }
  | { readonly ok: false; readonly errors: LaunchFieldErrors }

/**
 * Turn the form's values into a `workflow.startAdHoc` request, or into field errors.
 *
 * @param values - Everything the controls hold.
 * @returns The parsed input, or a refusal per offending control. Never both, and never neither —
 *   a submission that produced no request and no error would leave the button dead.
 */
export const toStartAdHocInput = (values: LaunchFormValues): LaunchSubmission => {
  const parsed = startAdHocInput.safeParse(toCandidate(values))

  if (parsed.success) {
    return { ok: true, input: parsed.data }
  }

  const errors: LaunchFieldErrors = {}
  for (const issue of parsed.error.issues) {
    const field = fieldForIssuePath(issue.path)
    // An issue that belongs to no control still has to reach somebody, so it lands on the
    // workspace choice — the only field whose shape can produce one.
    const target = field ?? 'workspaceSource'
    errors[target] ??= { code: codeFor(target), action: FIELD_ACTIONS[target] }
  }

  return { ok: false, errors }
}

/**
 * The next action for one field, for a caller that needs it outside a failed parse.
 *
 * @param field - The control.
 */
export const launchFieldAction = (field: LaunchFieldName): string => FIELD_ACTIONS[field]
