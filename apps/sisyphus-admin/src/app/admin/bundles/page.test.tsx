import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

/**
 * The page is wiring: a provider, a list query, four mutations and one shaping function.
 *
 * The shaping function is where a mistake would be invisible, so it is asserted directly against a
 * listed bundle. The render assertions cover what the page itself contributes — the heading, the
 * immutability rule an admin reads before replacing an archive, and the token-only column — with
 * the tRPC hooks stubbed, because with no testing library available there is nothing here to drive
 * a live query with. The mutations' own behaviour belongs to `admin.bundles`, which has its suites
 * in `packages/sisyphus-api`.
 */

vi.mock('./upload-action', () => ({
  uploadBundleArchiveAction: () =>
    Promise.resolve({ ok: false, error: { code: 'x', action: 'y' } }),
}))

vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))

const listQuery = vi.fn((): unknown => ({ data: undefined, isPending: true }))
const useMutation = () => ({ mutate: vi.fn() })

vi.mock('@sisyphus-admin/trpc', () => ({
  TRPCReactProvider: ({ children }: { children: unknown }) => children,
  api: {
    useUtils: () => ({ admin: { bundles: { list: { invalidate: () => Promise.resolve() } } } }),
    admin: {
      bundles: {
        list: { useQuery: listQuery },
        register: { useMutation },
        replaceArchive: { useMutation },
        setEnabled: { useMutation },
        validate: { useMutation },
      },
    },
  },
}))

const { default: BundlesPage, toBundleSummary } = await import('./page')

const listedBundle = {
  id: 'bundle-1',
  name: 'node-22',
  description: 'Node 22 with pnpm.',
  enabled: true,
  spendCapsEnforceable: false,
  archivedAt: null,
  createdAt: new Date('2026-08-01T09:00:00.000Z'),
  latestVersion: {
    id: 'version-3',
    version: 3,
    contentDigest: 'a'.repeat(64),
    sizeBytes: 2048,
    registeredByUserId: 'user-1',
    createdAt: new Date('2026-08-04T11:30:00.000Z'),
  },
  latestValidation: {
    id: 'run-7',
    setupBundleVersionId: 'version-3',
    version: 3,
    outcome: 'passed' as const,
    startedAt: new Date('2026-08-04T11:31:00.000Z'),
    endedAt: new Date('2026-08-04T11:36:00.000Z'),
  },
}

describe('toBundleSummary', () => {
  it('labels the version’s createdAt as when the archive was registered', () => {
    const summary = toBundleSummary(listedBundle)

    expect(summary.latestVersion?.registeredAt).toStrictEqual(new Date('2026-08-04T11:30:00.000Z'))
    expect(summary.latestVersion?.version).toBe(3)
    expect(summary.latestVersion?.contentDigest).toBe('a'.repeat(64))
  })

  it('carries the validation with the version it exercised, so a stale pass is visible (FR-148)', () => {
    const summary = toBundleSummary(listedBundle)

    expect(summary.latestValidation).toStrictEqual({
      version: 3,
      outcome: 'passed',
      startedAt: new Date('2026-08-04T11:31:00.000Z'),
      endedAt: new Date('2026-08-04T11:36:00.000Z'),
    })
  })

  it('leaves a never-validated bundle undefined rather than inventing a null-outcome run', () => {
    const summary = toBundleSummary({ ...listedBundle, latestValidation: undefined })

    expect('latestValidation' in summary).toBe(false)
  })

  it('leaves a bundle with no version undefined rather than faking version zero', () => {
    const summary = toBundleSummary({ ...listedBundle, latestVersion: undefined })

    expect('latestVersion' in summary).toBe(false)
  })

  it('keeps an in-flight validation’s null outcome, which is not the same as never validated', () => {
    const summary = toBundleSummary({
      ...listedBundle,
      latestValidation: { ...listedBundle.latestValidation, outcome: null, endedAt: null },
    })

    expect(summary.latestValidation?.outcome).toBeNull()
    expect(summary.latestValidation?.endedAt).toBeNull()
  })
})

describe('the bundles page', () => {
  it('names itself and says what a bundle is for', () => {
    const markup = renderToStaticMarkup(<BundlesPage />)

    expect(markup).toContain('Setup bundles')
    expect(markup).toContain('turns a bare instance')
  })

  it('states the immutability rule where an admin about to replace an archive will read it (FR-090)', () => {
    const markup = renderToStaticMarkup(<BundlesPage />)

    expect(markup).toContain('immutable once registered')
    expect(markup).toContain('runs already under way')
  })

  it('renders the registration form, and the list’s reading state rather than its empty state', () => {
    const markup = renderToStaticMarkup(<BundlesPage />)

    expect(markup).toContain('register a bundle')
    expect(markup).toContain('Reading the bundle list')
  })

  it('renders the bundles the list returned', () => {
    listQuery.mockReturnValueOnce({
      data: { items: [listedBundle], nextCursor: undefined },
      isPending: false,
    })

    const markup = renderToStaticMarkup(<BundlesPage />)

    expect(markup).toContain('node-22')
    expect(markup).toContain('v3')
    expect(markup).toContain('passed v3')
  })

  it('is a single column inside the page gutter, from tokens only (SC-015)', () => {
    const markup = renderToStaticMarkup(<BundlesPage />)

    expect(markup).toContain('max-w-column')
    expect(markup).toContain('p-gutter')
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="[^"]*\d+px/)
  })
})
