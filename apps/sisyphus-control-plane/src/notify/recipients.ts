import type { AudienceMember, AudienceRelation } from './notification-store'

/**
 * Who actually gets the message — the two defaults that decide it, as pure functions (FR-138,
 * FR-140).
 *
 * Both are about an **absence**, which is why they live here with tests rather than as `where`
 * clauses. A rule expressed only in SQL is invisible to a reader of the delivery path, and both of
 * these fail silently when inverted: the software still runs, it just stops telling anyone.
 *
 * 1. **No preference row means enabled.** `notification_preferences` holds a row only where a user
 *    made a decision, so most users have none, and an implementation that read the table as the
 *    list of people to notify would notify nobody. See `db/schema/notify.ts`, which states the
 *    rule at the schema, and the twin fold in `sisyphus-api`'s `workflow/watch.ts`, which serves
 *    the panel's preferences screen.
 * 2. **No Slack id means unnotifiable, not undeliverable.** FR-140 requires such a user to be
 *    recorded and surfaced, and explicitly requires that they do not cause the run to fail. So they
 *    stay in the recipient list, carrying `notifiable: false`, and `./delivery.ts` writes them an
 *    `unnotifiable` row. Filtering them out here would make the panel unable to show the thing
 *    FR-140 asks it to show.
 */

/** One person the message is for, after both defaults have been applied. */
export interface NotificationRecipient {
  readonly userId: string
  readonly displayName: string
  /** `null` when the user has no resolvable Slack identity (FR-140). */
  readonly slackUserId: string | null
  readonly relation: AudienceRelation
  /** False when there is no Slack identity to deliver to. Still a recipient (FR-140). */
  readonly notifiable: boolean
}

/**
 * Whether a stored preference means "send it".
 *
 * `?? true`, never `=== true`. The distinction is the whole rule: `null` is "no decision recorded",
 * and the default for no decision is on.
 *
 * @param stored - The left-joined `enabled` column, `null` where no row exists.
 */
export const wantsEvent = (stored: boolean | null): boolean => stored ?? true

/**
 * Reduce a raw audience to the people who will be written a notification.
 *
 * Removes exactly two kinds of member and nothing else:
 *
 * - **opted out** — they recorded `enabled: false` for this event (FR-138);
 * - **deactivated** — their access was withdrawn (FR-176). A deactivated owner's runs are already
 *   flagged `needs_reassignment`, and messaging an account that can no longer sign in is not the
 *   remedy; the panel's needs-attention view is.
 *
 * The owner wins over a duplicate watcher row, so a person who both owns and watches a run gets one
 * message rather than two — the smallest case of FR-139's "one workflow cannot produce a burst",
 * and the one most likely to occur.
 *
 * @param audience - As read by {@link NotificationStore.readAudience}, unfiltered.
 */
export const selectRecipients = (
  audience: readonly AudienceMember[],
): readonly NotificationRecipient[] => {
  const chosen = new Map<string, NotificationRecipient>()

  for (const member of audience) {
    if (!member.isActive || !wantsEvent(member.preferenceEnabled)) {
      continue
    }

    const existing = chosen.get(member.userId)
    if (existing?.relation === 'owner') {
      continue
    }

    chosen.set(member.userId, {
      userId: member.userId,
      displayName: member.displayName,
      slackUserId: member.slackUserId,
      relation: member.relation,
      // The FR-140 case. Recorded, surfaced, and harmless to the run.
      notifiable: member.slackUserId !== null && member.slackUserId !== '',
    })
  }

  return [...chosen.values()]
}

/** The recipients that will produce an `unnotifiable` row rather than a message (FR-140). */
export const unnotifiableRecipients = (
  recipients: readonly NotificationRecipient[],
): readonly NotificationRecipient[] => recipients.filter((recipient) => !recipient.notifiable)
