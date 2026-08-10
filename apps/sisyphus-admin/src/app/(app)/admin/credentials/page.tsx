import { PageHeader } from '@sisyphus-admin/components/shell'
import { requireAdminPage } from '@sisyphus-admin/server'

import { CredentialsPanel } from './credentials-panel'

/**
 * `/admin/credentials` — the agent credential pool (T034, 003/FR-004..FR-009, 003/FR-061).
 *
 * ## The gate is why a non-admin sees nothing, rather than a style applied to output that exists
 *
 * FR-004 makes registering, editing, disabling and deleting a credential admin-only, and
 * data-model.md's access scoping makes the *reads* admin-only too: a seat's state tells an engineer
 * nothing they can act on. `requireAdminPage` resolves the session on the **server** and throws
 * Next.js's `notFound`, so the JSX below is never evaluated — no markup, no queries mounted,
 * nothing in the response to read. `not-found` rather than `forbidden`, decided once in
 * `@sisyphus-admin/server`, because a permission page confirms that what is behind it exists
 * (FR-190).
 *
 * ## What this page deliberately does not do
 *
 * It does not log a seat in; it **links** to the page that does (`./[id]/login`). A login is a
 * session with a provisioned instance at the other end of it, and it needs somewhere to draw a
 * terminal and count down a deadline — a control in a list row would have started all of that and
 * had nowhere to put what came back.
 *
 * It also holds no input of any kind. Until Phase 7 each row carried a field for the name of a
 * secret an operator had written by hand with the AWS CLI; that field and the procedure behind it
 * are gone, along with quickstart.md's Scenario 2a. It took an identifier and never material, so
 * FR-011 and FR-070 held — but a seat could reach `available` without a login ever having happened,
 * which is what FR-008 is about.
 *
 * Dynamic, because the page is a function of the caller's session.
 */
export const dynamic = 'force-dynamic'

const CredentialsAdminPage = async () => {
  await requireAdminPage()

  return (
    <>
      <PageHeader
        eyebrow="Capacity"
        title="Agent credentials"
        summary="Every seat the platform can work as, and which group it draws from. A seat is held by at most one run at a time and becomes usable only once a login has been completed inside the platform’s own infrastructure — the material that login produces is captured server-side and never passes through this page."
      />
      <CredentialsPanel />
    </>
  )
}

export default CredentialsAdminPage
