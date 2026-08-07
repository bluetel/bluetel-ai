/**
 * What EventBridge Scheduler resources are called.
 *
 * Separated from the construct because a schedule name is the thing FR-100's
 * create/update/remove-on-change depends on: the name is derived from the
 * integration id, so re-registering an integration is an idempotent upsert
 * rather than a lookup by tag. A name that silently collided with another
 * integration's would stop one board being polled, and nothing would report it —
 * which is why the collision case throws here and is asserted here rather than
 * discovered in production (FR-200).
 */

import { getResourceIdentifier, type ResourceScope } from './lib'

/** EventBridge Scheduler accepts `[0-9a-zA-Z-_.]` and caps names at 64 characters. */
const SCHEDULE_NAME_MAX_LENGTH = 64
const DISALLOWED_NAME_CHARACTERS = /[^0-9a-zA-Z\-_.]/g

/**
 * Coerces an arbitrary identifier into a legal schedule name, and refuses
 * rather than silently truncating — a truncated name would collide with another
 * integration's schedule and one board would silently stop being polled.
 */
export const toScheduleName = (rawName: string): string => {
  const sanitised = rawName.replace(DISALLOWED_NAME_CHARACTERS, '-')

  if (sanitised === '') {
    throw new Error('Cannot build a schedule name from an empty identifier')
  }

  if (sanitised.length > SCHEDULE_NAME_MAX_LENGTH) {
    throw new Error(
      `Schedule name "${sanitised}" exceeds the ${String(SCHEDULE_NAME_MAX_LENGTH)}-character limit; ` +
        `truncating it would risk colliding with another schedule.`,
    )
  }

  return sanitised
}

/** The one schedule group a stage's schedules live in. */
export const getSchedulerGroupName = (scope: ResourceScope): string =>
  toScheduleName(getResourceIdentifier(scope, 'schedules'))

/** The control plane's own tick — the job the panel cannot invoke (FR-035). */
export const getControlPlaneTickName = (scope: ResourceScope): string =>
  toScheduleName(getResourceIdentifier(scope, 'control-plane-tick'))

/**
 * The schedule that polls one integration. Derived from the integration id, so
 * registering it again updates the same schedule (FR-100).
 */
export const getIntegrationScheduleName = (scope: ResourceScope, integrationId: string): string =>
  toScheduleName(getResourceIdentifier(scope, `integration-${integrationId}`))
