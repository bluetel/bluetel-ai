import { z } from 'zod'

import { INTEGRATION_TYPES } from '../enums'

import { cursorPagination, nonEmptyText, uuidInput } from './common'

/**
 * Inputs for `admin.integrations` — external systems that start runs (FR-096..FR-107, FR-130).
 *
 * No credential ever appears in these shapes. An integration names a secret by ARN; the value
 * lives in the secret store and is read at tick time, so a credential cannot reach the panel, the
 * audit log or a validation error message.
 */

/** Ordered first-match mapping from ticket criteria to an execution profile (FR-130, FR-131). */
export const integrationMappingInput = z.object({
  position: z.number().int().nonnegative(),
  criteria: z.record(z.string(), z.unknown()),
  executionProfileId: uuidInput,
  isDefault: z.boolean().default(false),
})

/**
 * Mappings are evaluated in `position` order and the first match wins, so the order is part of the
 * configuration rather than an incidental property of the list. Duplicate positions would make
 * which profile a ticket gets depend on row order in the database.
 */
export const integrationMappingListInput = z
  .array(integrationMappingInput)
  .superRefine((mappings, ctx) => {
    const positions = new Set(mappings.map((mapping) => mapping.position))
    if (positions.size !== mappings.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Mapping positions must be unique — first match wins, so order must be decided.',
      })
    }

    if (mappings.filter((mapping) => mapping.isDefault).length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At most one mapping may be the default.',
      })
    }
  })

/** The discovery and rate-limit settings shared by create and update. */
export const integrationSettingsInput = z.object({
  name: nonEmptyText,
  baseUrl: z.string().url(),
  credentialSecretArn: nonEmptyText,
  projectPrefix: nonEmptyText,
  label: nonEmptyText,
  extraFilters: z.record(z.string(), z.unknown()).nullish(),
  defaultOwnerUserId: uuidInput.nullish(),
  promptIntro: nonEmptyText,
  cronExpression: nonEmptyText,
  timezone: nonEmptyText,
  /** Ceilings are required, not defaulted: an unbounded tick is an unbounded bill (FR-105). */
  perTickCeiling: z.number().int().positive(),
  rollingPeriodCeiling: z.number().int().positive(),
  rollingPeriodMinutes: z.number().int().positive(),
  mappings: integrationMappingListInput,
})

export const integrationIdInput = z.object({ integrationId: uuidInput })

export const listIntegrationsInput = cursorPagination.extend({
  enabledOnly: z.boolean().default(false),
  type: z.enum(INTEGRATION_TYPES).optional(),
})

export const createIntegrationInput = integrationSettingsInput.extend({
  type: z.enum(INTEGRATION_TYPES),
})

export const updateIntegrationInput = integrationSettingsInput.extend({
  integrationId: uuidInput,
})

export const setIntegrationEnabledInput = z.object({
  integrationId: uuidInput,
  enabled: z.boolean(),
})

/** Connectivity check before enable, so a misconfigured integration fails visibly (FR-106). */
export const validateIntegrationInput = integrationIdInput

/** A manual tick, subject to the same ceilings as a scheduled one (FR-107). */
export const runIntegrationNowInput = integrationIdInput

export const listIntegrationRunsInput = cursorPagination.extend({
  integrationId: uuidInput,
})

/**
 * Render the assembled prompt for a sample ticket before enabling (FR-160).
 *
 * Reviewing what the agent will actually be told is the difference between configuring an
 * integration and guessing at one.
 */
export const previewIntegrationPromptInput = z.object({
  integrationId: uuidInput,
  externalId: nonEmptyText,
})

export type IntegrationMappingInput = z.infer<typeof integrationMappingInput>
export type IntegrationIdInput = z.infer<typeof integrationIdInput>
export type ListIntegrationsInput = z.infer<typeof listIntegrationsInput>
export type CreateIntegrationInput = z.infer<typeof createIntegrationInput>
export type UpdateIntegrationInput = z.infer<typeof updateIntegrationInput>
export type SetIntegrationEnabledInput = z.infer<typeof setIntegrationEnabledInput>
export type PreviewIntegrationPromptInput = z.infer<typeof previewIntegrationPromptInput>
