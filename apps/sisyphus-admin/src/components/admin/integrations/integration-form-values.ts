import { createIntegrationInput } from '@bluetel-ai/sisyphus-api/client'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'

import type { IntegrationSubmission, IntegrationView } from './integrations-client'
import { isKnownTimezone, scheduleReadback } from './schedule-presets'

/**
 * The integration editor's values, and the one place they become a request (T121).
 *
 * The same three rules `profile-form-values.ts` follows, for the same reasons: the form's state is
 * all strings because that is what a control holds; the conversion happens once, here; and the
 * validation is the **server's own schema**, so a form and its procedure cannot disagree about a
 * field name or a rule (FR-008).
 *
 * ## The credential is the exception, and deliberately so
 *
 * {@link draftFromIntegration} does **not** pre-fill `credentialSecretArn`, because nothing returns
 * it (FR-098). Editing an integration therefore means re-stating which secret it uses. That is the
 * intended cost of a write-only field: a form that could pre-fill it is a form the value can be
 * read back out of, and a credential you can read back out of a panel is a credential you have to
 * rotate. {@link EDIT_CREDENTIAL_NOTICE} is what the editor says about it, so an admin meets the
 * rule as an explanation rather than as an empty box.
 *
 * ## The schedule is validated here, not only rendered
 *
 * FR-154 requires the readback and the fire times to be shown *before* the schedule can be saved.
 * A readback the form ignores is decoration, so {@link toCreateIntegrationValues} refuses an
 * expression or a timezone the panel could not evaluate — the same expression the control plane
 * would refuse to register (`sync-schedules.ts`), caught while the admin is still looking at it.
 */

/** What the editor holds, as the controls hold it. */
export interface IntegrationDraft {
  readonly name: string
  readonly baseUrl: string
  /** Always blank on load. See the note above. */
  readonly credentialSecretArn: string
  readonly projectPrefix: string
  readonly label: string
  readonly extraFilters: string
  readonly defaultOwnerUserId: string
  readonly promptIntro: string
  readonly cronExpression: string
  readonly timezone: string
  readonly perTickCeiling: string
  readonly rollingPeriodCeiling: string
  readonly rollingPeriodMinutes: string
  readonly mappings: readonly IntegrationMappingDraft[]
}

export interface IntegrationMappingDraft {
  readonly position: string
  readonly criteria: string
  readonly executionProfileId: string
  readonly isDefault: boolean
}

export type IntegrationFieldName = keyof IntegrationDraft

export type IntegrationDraftErrors = Partial<Record<IntegrationFieldName, FieldErrorContent>>

export const EDIT_CREDENTIAL_NOTICE =
  'The credential reference is never returned by the platform, so it has to be entered again on every edit. That is what makes it write-only rather than merely hidden.'

/** A new integration, with nothing chosen. */
export const EMPTY_INTEGRATION: IntegrationDraft = {
  name: '',
  baseUrl: '',
  credentialSecretArn: '',
  projectPrefix: '',
  label: '',
  extraFilters: '',
  defaultOwnerUserId: '',
  promptIntro: '',
  cronExpression: '',
  timezone: '',
  perTickCeiling: '',
  rollingPeriodCeiling: '',
  rollingPeriodMinutes: '',
  mappings: [],
}

/** Load an existing integration into the editor — **without** its credential. */
export const draftFromIntegration = (integration: IntegrationView): IntegrationDraft => ({
  name: integration.name,
  baseUrl: integration.baseUrl,
  credentialSecretArn: '',
  projectPrefix: integration.projectPrefix,
  label: integration.label,
  extraFilters:
    integration.extraFilters === null ? '' : JSON.stringify(integration.extraFilters, null, 2),
  defaultOwnerUserId: integration.defaultOwnerUserId ?? '',
  promptIntro: integration.promptIntro,
  cronExpression: integration.cronExpression,
  timezone: integration.timezone,
  perTickCeiling: String(integration.perTickCeiling),
  rollingPeriodCeiling: String(integration.rollingPeriodCeiling),
  rollingPeriodMinutes: String(integration.rollingPeriodMinutes),
  mappings: integration.mappings.map((mapping) => ({
    position: String(mapping.position),
    criteria: JSON.stringify(mapping.criteria, null, 2),
    executionProfileId: mapping.executionProfileId,
    isDefault: mapping.isDefault,
  })),
})

/** A submission, or the field-level refusals that stopped it. */
export type IntegrationSubmissionResult =
  | { readonly ok: true; readonly input: IntegrationSubmission }
  | { readonly ok: false; readonly errors: IntegrationDraftErrors }

const parseJsonObject = (
  text: string,
):
  | { readonly ok: true; readonly value: Record<string, unknown> | null }
  | { readonly ok: false } => {
  if (text.trim().length === 0) {
    return { ok: true, value: null }
  }

  try {
    const parsed: unknown = JSON.parse(text)

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false }
    }

    return { ok: true, value: parsed as Record<string, unknown> }
  } catch {
    return { ok: false }
  }
}

const numberOrNaN = (text: string): number =>
  text.trim().length === 0 ? Number.NaN : Number(text.trim())

const fieldError = (code: string, action: string): FieldErrorContent => ({ code, action })

/**
 * Turn a draft into the request `admin.integrations.create` accepts.
 *
 * @param draft - The editor's values.
 * @param now - Injectable, so the fire-time check in a test is not a race against midnight.
 */
export const toCreateIntegrationValues = (
  draft: IntegrationDraft,
  now: Date = new Date(),
): IntegrationSubmissionResult => {
  const errors: Record<string, FieldErrorContent> = {}

  const filters = parseJsonObject(draft.extraFilters)
  if (!filters.ok) {
    errors.extraFilters = fieldError(
      'not_a_json_object',
      'Extra filters must be a JSON object, or blank for none.',
    )
  }

  const mappings: {
    position: number
    criteria: Record<string, unknown>
    executionProfileId: string
    isDefault: boolean
  }[] = []
  for (const mapping of draft.mappings) {
    const criteria = parseJsonObject(mapping.criteria)

    if (!criteria.ok) {
      errors.mappings = fieldError(
        'not_a_json_object',
        'Every mapping criterion must be a JSON object.',
      )
      continue
    }

    mappings.push({
      position: numberOrNaN(mapping.position),
      criteria: criteria.value ?? {},
      executionProfileId: mapping.executionProfileId,
      isDefault: mapping.isDefault,
    })
  }

  if (!isKnownTimezone(draft.timezone)) {
    errors.timezone = fieldError(
      'unknown_timezone',
      'Choose a timezone the platform can evaluate, since the schedule is read in it (FR-155).',
    )
  } else if (!scheduleReadback(draft.cronExpression, draft.timezone, now).readable) {
    // FR-154: the readback and the fire times must be shown before a schedule can be saved, so an
    // expression that produces neither cannot be saved either.
    errors.cronExpression = fieldError(
      'unreadable_schedule',
      'Pick a preset, or write an expression whose next run times the panel can show.',
    )
  }

  const candidate = {
    type: 'jira' as const,
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    credentialSecretArn: draft.credentialSecretArn.trim(),
    projectPrefix: draft.projectPrefix.trim(),
    label: draft.label.trim(),
    extraFilters: filters.ok ? filters.value : null,
    defaultOwnerUserId: draft.defaultOwnerUserId.trim() === '' ? null : draft.defaultOwnerUserId,
    promptIntro: draft.promptIntro.trim(),
    cronExpression: draft.cronExpression.trim(),
    timezone: draft.timezone.trim(),
    perTickCeiling: numberOrNaN(draft.perTickCeiling),
    rollingPeriodCeiling: numberOrNaN(draft.rollingPeriodCeiling),
    rollingPeriodMinutes: numberOrNaN(draft.rollingPeriodMinutes),
    mappings,
  }

  // The server's own schema, so the panel and the resolver are one rule rather than two that agree
  // today. Field paths come back as the draft's own names, which is what lets each refusal land
  // under the control that produced it.
  const parsed = createIntegrationInput.safeParse(candidate)

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [field] = issue.path

      // A nested or indexed path (a mapping's own field) is reported against the control an admin
      // can actually see, rather than under a key nothing renders.
      if (typeof field !== 'string' || field.length === 0) {
        continue
      }

      errors[field] ??= fieldError(issue.code, issue.message)
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors: errors as IntegrationDraftErrors }
  }

  return { ok: true, input: candidate }
}

/** The same conversion, addressed at an existing integration. */
export const toUpdateIntegrationValues = (
  integrationId: string,
  draft: IntegrationDraft,
  now: Date = new Date(),
):
  | {
      readonly ok: true
      readonly input: IntegrationSubmission & { readonly integrationId: string }
    }
  | { readonly ok: false; readonly errors: IntegrationDraftErrors } => {
  const result = toCreateIntegrationValues(draft, now)

  return result.ok ? { ok: true, input: { integrationId, ...result.input } } : result
}
