import {
  AuditPanel,
  parseAuditScope,
  parseConfigurationScope,
} from '@sisyphus-admin/components/admin/audit'
import { PageHeader } from '@sisyphus-admin/components/shell'
import { requireAdminPage } from '@sisyphus-admin/server'

/**
 * `/admin/audit` — the configuration audit view (T136, FR-177, FR-183, FR-184).
 *
 * ## The gate is why this page renders nothing for a non-admin
 *
 * `requireAdminPage` resolves the session on the server and throws Next.js's `notFound` for anyone
 * who is not an active admin, so the JSX below is never evaluated: no markup, no queries mounted,
 * nothing to read in the response. A client-side hide would have shipped all three — and on an
 * audit trail, the markup is the disclosure.
 *
 * `notFound` rather than a refusal, for the same reason an out-of-scope read is `NOT_FOUND`: a page
 * that said "you do not have permission" would confirm what is behind it.
 *
 * ## Why the subject is parsed here
 *
 * The server component is the first thing that sees the query string, so parsing here means the
 * first render is already the narrowed trail rather than the whole platform's history flashing past
 * on the way to one account's. The parse is total: a subject that is not an identifier is dropped
 * rather than forwarded, so a stale link produces a history rather than a validation error.
 *
 * ## The page resolves nothing itself
 *
 * No entry count and nothing in the heading that depends on what has been recorded. The trails are
 * read by the two admin procedures the panel calls.
 *
 * Dynamic, because the page is a function of the caller's session and of the query string.
 */
export const dynamic = 'force-dynamic'

interface AuditPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>
}

const AuditPage = async ({ searchParams }: AuditPageProps) => {
  await requireAdminPage()
  const params = await searchParams

  return (
    <>
      <PageHeader
        eyebrow="Access"
        title="Configuration audit"
        summary="Who changed what, and when. Every role change, activation, profile grant and revocation, and every change to a setup bundle, workspace, execution profile or integration — with the admin behind it. The record is appended to and never edited or deleted; there is nothing on this page that writes."
      />
      <AuditPanel
        initialScope={parseAuditScope(params)}
        initialConfigurationScope={parseConfigurationScope(params)}
      />
    </>
  )
}

export default AuditPage
