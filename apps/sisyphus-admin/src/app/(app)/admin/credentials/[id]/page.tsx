import { PageHeader } from '@sisyphus-admin/components/shell'
import { requireAdminPage } from '@sisyphus-admin/server'

import { CredentialRecoveryPanel } from './credential-recovery-panel'

/**
 * `/admin/credentials/{id}` — one seat, and what to do about it (T121, 003/FR-005, FR-006, FR-010,
 * FR-057, FR-072, 003/SC-012).
 *
 * The parent of `./login`, and the screen US9 is actually about: a broken seat is taken out of
 * service, forced free, logged in again and returned, without disturbing any other run. The pool
 * list says *which* seat; this says what the recovery is and in what order, because the order is
 * the part that is not obvious — disabling a seat a run is holding withholds it from future
 * selection and interrupts nothing (FR-006), so it has to be forced free before it can be logged in
 * again.
 *
 * ## Two refusals, and they are different refusals
 *
 * The same pair as `./login`, decided in the same two places:
 *
 * 1. **The caller is not an admin.** `requireAdminPage` resolves the session on the *server* and
 *    throws Next.js's `notFound`, so nothing below runs — no markup, no queries mounted (FR-169,
 *    003/FR-004).
 * 2. **The credential does not exist.** Not decided here. The id in the URL is the caller's guess,
 *    and the router answers `NOT_FOUND` identically for a seat that was never registered and one
 *    that was archived. Resolving the credential here to put its name in the heading would undo
 *    that: a page that can title itself has confirmed the seat exists (FR-190).
 *
 * So the heading is fixed text and the seat's name appears inside the panel, from a query the
 * router has already decided the caller may make.
 *
 * Dynamic, because the page is a function of the caller's session.
 */
export const dynamic = 'force-dynamic'

interface CredentialDetailPageProps {
  params: Promise<{ id: string }>
}

const CredentialDetailPage = async ({ params }: CredentialDetailPageProps) => {
  await requireAdminPage()
  const { id } = await params

  return (
    <>
      <PageHeader
        eyebrow="Agent credential"
        title="Seat"
        summary="Recovering a broken seat is three steps in one order: disable it so the pool stops offering it, force-release it from the run holding it — which ends that run, because a workflow is never moved to a different credential — and then log in again through the same flow a new seat goes through. Deleting is refused for any seat a workflow has ever held; disable it instead."
      />
      <CredentialRecoveryPanel agentCredentialId={id} />
    </>
  )
}

export default CredentialDetailPage
