import { PageHeader } from '@sisyphus-admin/components/shell'
import { requireAdminPage } from '@sisyphus-admin/server'

import { CredentialLoginPanel } from './credential-login-panel'

/**
 * `/admin/credentials/{id}/login` — the hosted login (T080, 003/FR-069..003/FR-072, 003/SC-001).
 *
 * ## Two refusals, and they are different refusals
 *
 * 1. **The caller is not an admin.** `requireAdminPage` resolves the session on the *server* and
 *    throws Next.js's `notFound`, so nothing below runs — no markup, no queries mounted (FR-169,
 *    003/FR-004). `not-found` rather than `forbidden`, decided once in `@sisyphus-admin/server`,
 *    because a permission page confirms that what is behind it exists (FR-190).
 * 2. **The credential does not exist.** That is not decided here. The id in the URL is the
 *    caller's guess, and the *router* answers `NOT_FOUND` identically for a seat that was never
 *    registered and one that was archived, so the two cannot be told apart. Resolving the
 *    credential here to put its name in the heading would undo it: a page that can title itself has
 *    confirmed the seat exists.
 *
 * That is why the heading is fixed text and the seat's name appears inside the panel, from a query
 * the router has already decided the caller may make.
 *
 * ## Why this is a page and not a control on the pool view
 *
 * A login is a session with an EC2 instance at the other end of it. It needs somewhere to draw a
 * terminal, somewhere to count down the deadline the environment was given, and somewhere to poll
 * while the platform captures what the agent produced. A button in a list row would have started
 * all of that and had nowhere to put what came back.
 *
 * Dynamic, because the page is a function of the caller's session.
 */
export const dynamic = 'force-dynamic'

interface CredentialLoginPageProps {
  params: Promise<{ id: string }>
}

const CredentialLoginPage = async ({ params }: CredentialLoginPageProps) => {
  await requireAdminPage()
  const { id } = await params

  return (
    <>
      <PageHeader
        eyebrow="Agent credential"
        title="Login"
        summary="The platform provisions a short-lived environment with nothing in it but the agent, and you complete the agent’s own login inside it over a relayed terminal. What the login produces is captured on that instance and written straight to the secret store — it is never sent to this page, displayed, or downloadable, and the environment is destroyed whether the attempt succeeds, fails or is abandoned."
      />
      <CredentialLoginPanel agentCredentialId={id} />
    </>
  )
}

export default CredentialLoginPage
