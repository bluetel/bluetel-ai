import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The page is a session read and a mount (T080, FR-122, FR-187).
 *
 * T064a gated the whole page on the admin role, because ad hoc entry was the only way to start a
 * run. The profile-first path is the path FR-122 says everybody has, so the page now renders for
 * any active session — `/workflows/layout.tsx` above it is what enforces that — and the *fields*
 * carry the role: `canLaunchAdHoc` is resolved here, on the server, and the direct-entry form is
 * not rendered without it.
 *
 * The gate that matters is neither of those. `workflow.startAdHoc` is an `adminProcedure` and
 * refuses a reconstructed request while recording it, which is covered in
 * `packages/sisyphus-api/src/server/workflow/start-ad-hoc.test.ts`.
 */
const auth = vi.fn()
const isAdminSessionUser = vi.fn()

vi.mock('@sisyphus-admin/lib/auth', () => ({ auth, isAdminSessionUser }))
vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))
vi.mock('@sisyphus-admin/components/workflows/new', () => ({
  LaunchPanel: () => null,
}))

const NewWorkflowPage = (await import('./page')).default
const { dynamic } = await import('./page')

beforeEach(() => {
  auth.mockReset()
  isAdminSessionUser.mockReset()
})

const renderFor = async (user: { id: string } | undefined, admin: boolean) => {
  auth.mockResolvedValue(user === undefined ? null : { user })
  isAdminSessionUser.mockReturnValue(admin)
  return NewWorkflowPage()
}

describe('the /workflows/new page', () => {
  it('lets an ad hoc launch through for an admin (FR-187)', async () => {
    const rendered = await renderFor({ id: 'admin' }, true)

    expect(JSON.stringify(rendered.props)).toContain('"canLaunchAdHoc":true')
  })

  it('does not render the direct-entry fields for a non-admin (FR-187)', async () => {
    const rendered = await renderFor({ id: 'engineer' }, false)

    expect(JSON.stringify(rendered.props)).toContain('"canLaunchAdHoc":false')
  })

  it('does not ask whether a caller with no session is an admin', async () => {
    const rendered = await renderFor(undefined, true)

    expect(isAdminSessionUser).not.toHaveBeenCalled()
    expect(JSON.stringify(rendered.props)).toContain('"canLaunchAdHoc":false')
  })

  it('is dynamic, because its output is a function of the caller’s session', () => {
    expect(dynamic).toBe('force-dynamic')
  })

  it('says pressing the button provisions nothing, which is the FR-035 boundary', async () => {
    const rendered = await renderFor({ id: 'admin' }, true)

    expect(JSON.stringify(rendered.props)).toContain('nothing is provisioned')
  })

  it('leads with the profile path in its own summary (FR-122)', async () => {
    const rendered = await renderFor({ id: 'engineer' }, false)

    expect(JSON.stringify(rendered.props)).toContain('Choose an execution profile')
  })
})
