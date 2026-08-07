import {
  NotificationPreferencesPanel,
  SlackIdentityReadout,
} from '@sisyphus-admin/components/settings'
import { PageHeader } from '@sisyphus-admin/components/shell'
import { auth, isActiveSessionUser } from '@sisyphus-admin/lib/auth'
import { createServerCaller } from '@sisyphus-admin/server'
import { notFound } from 'next/navigation'

/**
 * `/settings/notifications` — the account-level notification settings screen (T157, FR-138, FR-140).
 *
 * ## Not an admin page, and that is the point
 *
 * Every other screen under a namespace of its own in this app opens with `requireAdminPage()`. This
 * one does not, and must not: a notification preference is about the caller's own account, the
 * procedures behind it are `authedProcedure`, and an engineer is exactly who needs it. The shell
 * has already resolved and gated the session for the whole `(app)` group; the session is resolved
 * again here for the same reason the group's layout has one inactive branch — a page that assumed
 * its layout ran would be a page whose safety depended on a file it does not import.
 *
 * ## Why the identity is read through a procedure and the preferences are not
 *
 * The Slack identity comes from `workflow.notificationSettings`, called in-process through
 * {@link createServerCaller}. It used to come from a hand-rolled `select` in this directory,
 * because `slack_user_id` was carried only by `admin.users.list` and widening an admin surface to
 * serve a self-service screen would have been the wrong repair. That module said in its own comment
 * to delete it once a per-caller procedure existed; the procedure exists, so it is gone. What the
 * page reads and what the API says a caller may read are now the same statement — including the
 * `authedProcedure` gate and the fact that the procedure takes **no input at all**, so there is no
 * shape of request that reads somebody else's account.
 *
 * Rendering it on the server rather than in the client panel is what makes FR-140's unnotifiable
 * state the first thing on the page instead of a card that pops in: it has to be legible *before*
 * someone spends a minute configuring messages that cannot be delivered.
 *
 * The preferences stay in the client panel, on `workflow.notificationPreferences`, because they are
 * also **written** there — a screen that read them on the server and wrote them over HTTP would
 * have two sources of truth about the same eight rows, and the panel's mutation invalidates the
 * query it reads from. `notificationSettings` carries the same list under `.preferences`, so
 * collapsing the two reads into one is available, but only by making the identity client-side too;
 * that trade is the pop-in above, and it is not worth one saved round trip.
 *
 * Dynamic, because the page is a function of the caller's session.
 */
export const dynamic = 'force-dynamic'

const NotificationSettingsPage = async () => {
  const user = (await auth())?.user

  // `notFound`, not a refusal: the shell redirects a signed-out visitor to sign in, and anyone who
  // reaches here without an active session is in a state sign-in would refuse too.
  if (!isActiveSessionUser(user)) notFound()

  const { slackUserId } = await createServerCaller().workflow.notificationSettings()

  return (
    <>
      <PageHeader
        eyebrow="Account"
        title="Notifications"
        summary="What the platform tells you about, and where it would tell you. These settings are yours alone — they cover the runs you own and the runs you watch, and no one else's view of anything."
      />
      <SlackIdentityReadout slackUserId={slackUserId} />
      <NotificationPreferencesPanel />
    </>
  )
}

export default NotificationSettingsPage
