import { PageHeader } from '@sisyphus-admin/components/shell'
import { requireAdminPage } from '@sisyphus-admin/server'

import { CredentialPoolPanel } from './credential-pool-panel'

/**
 * `/admin/credentials/pool` — the one view that answers "should we buy another seat", per group
 * (T113, 003/FR-053, FR-054, FR-055, FR-074, SC-011).
 *
 * ## The gate is the requirement
 *
 * FR-053 makes the pool view administrator-only in as many words, and data-model.md → Access scoping
 * says why that is stricter than 002's profile-scoped model: a credential is platform
 * infrastructure, and its state — held, cooling off, unhealthy — tells an engineer nothing they can
 * act on. The one fact that *is* theirs, that their own run is waiting for a seat and for how long
 * (SC-006), reaches them on the workflow view through the existing workflow scoping and never
 * through this page.
 *
 * `requireAdminPage` resolves the session on the **server** and throws Next.js's `notFound`, so the
 * JSX below is never evaluated: no markup, no queries mounted, nothing in the response to read.
 * `not-found` rather than `forbidden`, decided once in `@sisyphus-admin/server`, because a
 * permission page confirms that what is behind it exists (FR-190). The router behind the panel is
 * gated a second time, with `adminProcedure`.
 *
 * ## Why the summary leads with the distinction rather than with the pool
 *
 * SC-011 is not "show the pool"; it is that an administrator can tell an under-sized **group** from
 * an under-sized **pool** in under thirty seconds, because those are different purchases. The header
 * says so before any number appears, so the figures below are read as evidence for a decision rather
 * than as a dashboard to interpret.
 *
 * ## What this page deliberately does not do
 *
 * It changes nothing. Registering a seat, logging one in, disabling one and force-releasing a lease
 * all live on `/admin/credentials`; groups live on `./groups`. This page reports, and a report that
 * could alter what it was reporting would make the pool's state depend on somebody looking at it.
 *
 * Dynamic, because the page is a function of the caller's session.
 */
export const dynamic = 'force-dynamic'

const CredentialPoolAdminPage = async () => {
  await requireAdminPage()

  return (
    <>
      <PageHeader
        eyebrow="Capacity"
        title="Credential pool"
        summary="Whether the platform has enough agent identities, and if not, which group is short. A group with runs waiting on it is under-sized even while other groups sit idle, because work launched under an execution profile is only ever performed by a credential in one of that profile’s attached groups — so the seats those other groups hold cannot serve it. Holders are broken down by what is holding them: a parked run keeps its seat indefinitely while showing no activity, which is the likeliest reason a full pool looks like an idle one."
      />
      <CredentialPoolPanel />
    </>
  )
}

export default CredentialPoolAdminPage
