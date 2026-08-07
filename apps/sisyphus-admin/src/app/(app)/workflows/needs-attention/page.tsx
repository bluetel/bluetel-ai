import { PageHeader } from '@sisyphus-admin/components/shell'
import { NeedsAttentionPanel } from '@sisyphus-admin/components/workflows/needs-attention'
import { auth, isAdminSessionUser } from '@sisyphus-admin/lib/auth'
import { notFound } from 'next/navigation'

/**
 * `/workflows/needs-attention` — what is waiting on you, and what has nobody (T088, FR-134,
 * FR-135, FR-176).
 *
 * ## Why the signed-in user is resolved here
 *
 * FR-135 scopes this view to "the signed-in user's owned workflows". The owner is therefore read
 * from the **session**, on the server, and never from the URL: a page that took an owner id as a
 * search parameter would be a way to ask what is waiting on somebody else, which is a different
 * screen with different rules — and, given the id is the caller's guess, an enumeration oracle
 * dressed as a filter.
 *
 * `/workflows/layout.tsx` above this has already refused anyone without an active session, so the
 * `notFound` below is unreachable in practice. It is here because the panel needs a user id and
 * there is no honest value for "no session": rendering the list for `''` would ask the server for
 * everything owned by nobody, which is a question this page has no business asking.
 *
 * The admin role decides only whether the **reassignment queue** is rendered, and not whether the
 * page is. Reassignment is `adminProcedure` — taking a run off the person it was delegated to is an
 * administrative act — so the section is not mounted for anyone else, rather than mounted and
 * refused, which would file a `not_admin` denial for the ordinary act of opening this page.
 *
 * Dynamic, because the page is a function of the caller's session.
 */
export const dynamic = 'force-dynamic'

const NeedsAttentionPage = async () => {
  const user = (await auth())?.user

  if (user === undefined) notFound()

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Needs attention"
        summary="Runs you own that have stopped and cannot go further without a person — and, for an admin, the runs whose owner was deactivated and which nobody is accountable for until they are handed on."
      />
      <NeedsAttentionPanel viewerUserId={user.id} canReassign={isAdminSessionUser(user)} />
    </>
  )
}

export default NeedsAttentionPage
