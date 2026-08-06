/**
 * The integration admin screen (T121, FR-096..FR-098, FR-154, FR-155, FR-160, FR-186).
 *
 * Consumers import this barrel, never a module inside it. Every primitive the screen renders comes
 * from `src/components/ui`; nothing here is a primitive.
 */

export { CredentialField } from './credential-field'

export {
  describeCron,
  formatInZone,
  instantFromWallClock,
  nextFireTimes,
  parseCron,
  parseCronField,
  wallClockIn,
} from './cron-schedule'
export type { CronField, CronFields, WallClock } from './cron-schedule'

export { IntegrationCard } from './integration-card'

export { IntegrationEditor } from './integration-editor'
export type { OwnerOption, ProfileOption } from './integration-editor'

export {
  draftFromIntegration,
  EDIT_CREDENTIAL_NOTICE,
  EMPTY_INTEGRATION,
  toCreateIntegrationValues,
  toUpdateIntegrationValues,
} from './integration-form-values'
export type {
  IntegrationDraft,
  IntegrationDraftErrors,
  IntegrationFieldName,
  IntegrationMappingDraft,
  IntegrationSubmissionResult,
} from './integration-form-values'

export { toIntegrationReadouts, wasAutoDisabled } from './integration-listing'
export type { IntegrationReadouts } from './integration-listing'

export {
  createUnavailableIntegrationsClient,
  INTEGRATIONS_UNAVAILABLE,
} from './integrations-client'
export type {
  IntegrationMappingView,
  IntegrationRunView,
  IntegrationsClient,
  IntegrationSubmission,
  IntegrationView,
  PromptPreviewView,
  ValidationView,
} from './integrations-client'

export { IntegrationsPanel } from './integrations-panel'

export { APPENDED_FIELDS, PromptPreview } from './prompt-preview'

export { ScheduleField } from './schedule-field'

export {
  CUSTOM_SCHEDULE_ID,
  expressionForPreset,
  isKnownTimezone,
  NEXT_RUN_COUNT,
  presetForExpression,
  SCHEDULE_PRESETS,
  scheduleReadback,
  timezoneOptions,
} from './schedule-presets'
export type { SchedulePreset, ScheduleReadback } from './schedule-presets'
