import { z } from 'zod'

import { NOTIFICATION_EVENTS } from '../enums'

import { uuidInput } from './common'

/**
 * Inputs for notification preferences and watchers (FR-136, FR-138).
 *
 * The vocabulary is imported from `src/enums/`, which is where it is defined and where its meaning
 * is tested. `src/db/schema/enums.ts` builds `notification_event` from the same tuple, so there is
 * one source for the panel, the resolvers and the database alike.
 *
 * {@link NOTIFICATION_EVENTS} is re-exported because the resolvers reach it through this barrel,
 * and both paths resolve to the same declaration.
 */

export { NOTIFICATION_EVENTS }

export const notificationEventInput = z.enum(NOTIFICATION_EVENTS)

/**
 * Set one preference.
 *
 * `enabled` has no default: **absence of a preference row means enabled**, so the default is not
 * silence. Defaulting this field would let a form that forgot to send it quietly mute an event.
 */
export const setNotificationPreferenceInput = z.object({
  event: notificationEventInput,
  enabled: z.boolean(),
})

/**
 * Watch or unwatch a run (FR-138).
 *
 * Scoped like a read, so a user cannot watch — and therefore cannot confirm the existence of — a
 * workflow outside their scope. An out-of-scope target returns `NOT_FOUND` for the same reason
 * every other out-of-scope read does (FR-190).
 */
export const watchWorkflowInput = z.object({ workflowId: uuidInput })

/**
 * Re-exported from `src/enums/` rather than inferred from {@link notificationEventInput}.
 *
 * `z.infer` would produce an identical union, but it would be a *second declaration* of it — and
 * the client barrel re-exports both this module and `src/enums/`, where two declarations of one
 * name is an ambiguous star export rather than a convenience.
 */
export type { NotificationEvent } from '../enums'

export type SetNotificationPreferenceInput = z.infer<typeof setNotificationPreferenceInput>
export type WatchWorkflowInput = z.infer<typeof watchWorkflowInput>
