import { eq } from 'drizzle-orm'

import type { SisyphusDatabase } from '../../db'
import { users } from '../../db'
import { authedProcedure } from '../procedures'

import type { EffectiveNotificationPreference } from './watch'
import { readNotificationPreferences } from './watch'

/**
 * **The account-level notification settings screen's one read (FR-138, FR-140).**
 *
 * FR-138 asks the settings screen for two things at once: the per-event preferences, *and* whether
 * the user's Slack identity resolved, surfacing FR-140's unnotifiable state. Until now the platform
 * could serve only the first. `admin.users.list` is the one read carrying `slack_user_id` and it is
 * an `adminProcedure`, so it is unavailable to exactly the engineers who need to know whether their
 * notifications will arrive — and widening an administrative user list to serve a self-service
 * screen would be the wrong repair, because the thing that makes it safe to widen is precisely that
 * it stops being a user list.
 *
 * ## Why this, and not `me.slackIdentity`
 *
 * A `me` router would be a new top-level surface holding one boolean-shaped fact, and the screen
 * would then make two requests to render one panel — arriving separately, so the panel would either
 * flash an "unnotifiable" warning it has not yet disproved or hold the preferences back waiting for
 * it. The two facts are one screen's state, so they are one read.
 *
 * It sits on the `workflow` router beside `notificationPreferences` and `setNotificationPreference`
 * for the same reason those do: `api-surface.md` puts the notification surface there, and inventing
 * a second home for the third procedure in the set would split it. Like them it is an
 * `authedProcedure` rather than a `scopedProcedure` — it names no workflow, so there is no visible
 * set for a scope to constrain and resolving one would put a `profile_access_grants` query on a
 * request that never reads it.
 *
 * ## The caller's own, structurally
 *
 * {@link notificationSettingsProcedure} takes **no input at all**. Not an optional user id, not one
 * defaulted to the session's — there is no field, so there is no request shape that reads somebody
 * else's Slack account or somebody else's preferences. That is the same discipline
 * `setNotificationPreference` follows and the reason its schema has no `userId` either.
 *
 * ## `null` is an answer, not a missing value
 *
 * `users.slack_user_id` is nullable and null means **unnotifiable** (FR-140): the identity did not
 * resolve, the account is recorded as unreachable, and no Slack message will be delivered. A
 * session whose user row has gone answers null as well, so the screen has one absent case to render
 * rather than two. {@link NotificationSettings.notifiable} states the consequence rather than
 * leaving every caller to rediscover that an absent id means silence — a panel that rendered
 * `slackUserId ?? 'not set'` and stopped there would be reporting a blank field, not a warning.
 */

/** What this read needs from a handle — the pool, or a transaction on it. */
export type NotificationSettingsReader = Pick<SisyphusDatabase, 'select'>

/**
 * The first row, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this project, so `rows[0]` is typed as present even when the
 * result set is empty, and a `=== undefined` guard against it is narrowed away as unreachable.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** Everything the settings screen renders, for the caller and nobody else. */
export interface NotificationSettings {
  /** The caller's resolved Slack member id, or `null` when nothing resolved (FR-140). */
  readonly slackUserId: string | null
  /**
   * Whether a notification can reach this person at all.
   *
   * Derived from `slackUserId`, and stated rather than left implicit: Slack direct message is the
   * only channel in scope (FR-136), so no identity means no delivery on any event, however the
   * preferences below are set.
   */
  readonly notifiable: boolean
  /** Every event with the caller's effective setting — absence of a row means enabled (FR-138). */
  readonly preferences: readonly EffectiveNotificationPreference[]
}

/**
 * Read one person's Slack identity.
 *
 * Selects a single column for a single id. The id is the session's at every call site, and this
 * function is not exported from the barrel, so there is no route by which a request value becomes
 * the argument.
 *
 * @param reader - A handle or transaction.
 * @param userId - Whose identity. Always the caller's.
 */
const readSlackIdentity = async (
  reader: NotificationSettingsReader,
  userId: string,
): Promise<string | null> => {
  const row = firstRow(
    await reader
      .select({ slackUserId: users.slackUserId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  )

  return row?.slackUserId ?? null
}

/**
 * The settings screen's state, for one user (FR-138, FR-140).
 *
 * Composes {@link readNotificationPreferences} rather than querying `notification_preferences`
 * again, so "absence of a row means enabled" has one implementation in this package and this read
 * cannot come to disagree with `workflow.notificationPreferences` about what a user has chosen.
 *
 * @param reader - A handle or transaction.
 * @param userId - Whose settings. Always the caller's own.
 */
export const readNotificationSettings = async (
  reader: NotificationSettingsReader,
  userId: string,
): Promise<NotificationSettings> => {
  const slackUserId = await readSlackIdentity(reader, userId)

  return {
    slackUserId,
    notifiable: slackUserId !== null,
    preferences: await readNotificationPreferences(reader, userId),
  }
}

/**
 * `workflow.notificationSettings` — ready to mount (FR-138, FR-140).
 *
 * No `.input(...)`, deliberately. See the module comment: the absence of an input schema is what
 * makes "the caller's own identity, never anybody else's" a property of the surface rather than a
 * check inside the resolver.
 */
export const notificationSettingsProcedure = authedProcedure.query(
  async ({ ctx }): Promise<NotificationSettings> => readNotificationSettings(ctx.db, ctx.user.id),
)
