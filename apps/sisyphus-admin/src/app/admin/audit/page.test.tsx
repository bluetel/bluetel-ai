import { describe, expect, it, vi } from 'vitest'

/**
 * The page gates, parses the subject and mounts the panel. Four properties are worth asserting:
 * that the gate runs before anything else, so a non-admin gets no markup rather than hidden markup;
 * that the subject reaches the panel already parsed; that a subject a hand-edited URL invented is
 * dropped rather than forwarded into a validation error; and that the page resolves nothing about
 * the record itself.
 */

const panel = vi.fn(() => null)
const requireAdminPage = vi.fn(async () => Promise.resolve({ id: 'admin' }))

vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))

vi.mock('@sisyphus-admin/server', () => ({ requireAdminPage }))

vi.mock('@sisyphus-admin/components/admin/audit', async () => {
  // The real parsers, so the page is exercised against the conversions it actually ships with;
  // only the panel is replaced, because mounting it would need a query client.
  const scope = await vi.importActual<{ parseAuditScope: unknown }>(
    '@sisyphus-admin/components/admin/audit/audit-scope',
  )
  const configuration = await vi.importActual<{ parseConfigurationScope: unknown }>(
    '@sisyphus-admin/components/admin/audit/configuration-scope',
  )

  return {
    AuditPanel: panel,
    parseAuditScope: scope.parseAuditScope,
    parseConfigurationScope: configuration.parseConfigurationScope,
  }
})

const AuditPage = (await import('./page')).default
const { dynamic } = await import('./page')

const SUBJECT = '0199a1f4-0000-7000-8000-0000000000ab'

const render = async (searchParams: Record<string, string | string[] | undefined>) => {
  panel.mockClear()
  const element = await AuditPage({ searchParams: Promise.resolve(searchParams) })
  return JSON.stringify(element, (_key, value: unknown) =>
    typeof value === 'function' ? '[component]' : value,
  )
}

describe('the /admin/audit page', () => {
  it('opens with the admin gate, which throws rather than hiding', async () => {
    requireAdminPage.mockClear()
    await render({})

    expect(requireAdminPage).toHaveBeenCalledTimes(1)
  })

  it('hands the panel the subject already parsed from the query string', async () => {
    expect(await render({ subject: SUBJECT })).toContain(`"subjectUserId":"${SUBJECT}"`)
  })

  it('drops a subject a hand-edited URL invented, so a stale link reads rather than errors', async () => {
    expect(await render({ subject: 'ada' })).toContain('"subjectUserId":""')
  })

  it('hands the panel the configuration narrowing from the same query string (FR-178)', async () => {
    const rendered = await render({ entity: 'setup_bundle', actor: SUBJECT })

    expect(rendered).toContain('"entityType":"setup_bundle"')
    expect(rendered).toContain(`"actorUserId":"${SUBJECT}"`)
  })

  it('drops a configuration filter a hand-edited URL invented', async () => {
    const rendered = await render({ entity: 'not_a_thing', entityId: 'ada' })

    expect(rendered).toContain('"entityType":""')
    expect(rendered).toContain('"entityId":""')
  })

  it('names itself without resolving anything about the record', async () => {
    const rendered = await render({})

    expect(rendered).toContain('Configuration audit')
    expect(rendered).not.toMatch(/"summary":"[^"]*\d+ entries/)
  })

  it('states in the page’s own words that nothing here writes (FR-177)', async () => {
    expect(await render({})).toContain('there is nothing on this page that writes')
  })

  it('is dynamic, because its output is a function of the caller’s session', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
