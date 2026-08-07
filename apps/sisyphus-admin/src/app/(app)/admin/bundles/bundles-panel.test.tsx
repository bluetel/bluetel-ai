import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { BundleSummary } from './bundles-panel'
import { BundlesPanel } from './bundles-panel'

const noop = () => undefined

const handlers = {
  onRegister: noop,
  onReplace: noop,
  onSetEnabled: noop,
  onValidate: noop,
}

const bundle = (overrides: Partial<BundleSummary> = {}): BundleSummary => ({
  id: 'bundle-1',
  name: 'acme-client',
  description: null,
  enabled: true,
  spendCapsEnforceable: false,
  latestVersion: {
    id: 'version-1',
    version: 1,
    contentDigest: 'ab'.repeat(32),
    sizeBytes: 1024,
    registeredAt: new Date('2026-08-05T10:00:00.000Z'),
  },
  ...overrides,
})

describe('BundlesPanel', () => {
  it('offers registration above the list, so a fresh stage has something to do', () => {
    const markup = renderToStaticMarkup(<BundlesPanel bundles={[]} {...handlers} />)

    expect(markup).toContain('register a bundle')
    expect(markup.indexOf('register a bundle')).toBeLessThan(markup.indexOf('setup bundles'))
  })

  it('says the list is empty rather than showing nothing at all', () => {
    const markup = renderToStaticMarkup(<BundlesPanel bundles={[]} {...handlers} />)

    expect(markup).toContain('no setup bundles are registered yet')
    expect(markup).toContain('data-note="empty"')
  })

  it('distinguishes an empty list from a list still being read', () => {
    const markup = renderToStaticMarkup(<BundlesPanel bundles={[]} loading {...handlers} />)

    expect(markup).toContain('reading the bundle list')
    expect(markup).toContain('data-note="loading"')
    expect(markup).not.toContain('data-note="empty"')
  })

  it('reports a refused list read, and withholds the claim that the shelf is empty (FR-201)', () => {
    const markup = renderToStaticMarkup(
      <BundlesPanel
        bundles={[]}
        listError={{ code: 'E_TARGET_NOT_FOUND', action: 'Reload the list.' }}
        {...handlers}
      />,
    )

    expect(markup).toContain('E_TARGET_NOT_FOUND')
    expect(markup).toContain('Reload the list.')
    expect(markup).not.toContain('no setup bundles are registered yet')
  })

  it('renders one card per bundle', () => {
    const markup = renderToStaticMarkup(
      <BundlesPanel
        bundles={[bundle(), bundle({ id: 'bundle-2', name: 'other-client' })]}
        {...handlers}
      />,
    )

    expect(markup).toContain('acme-client')
    expect(markup).toContain('other-client')
    expect(markup.match(/<section/g)).toHaveLength(3)
  })

  it('shows every bundle its most recent validation result, honestly (FR-148)', () => {
    const markup = renderToStaticMarkup(
      <BundlesPanel
        bundles={[
          bundle(),
          bundle({
            id: 'bundle-2',
            name: 'validated-client',
            latestValidation: {
              version: 1,
              outcome: 'failed',
              startedAt: new Date('2026-08-05T12:00:00.000Z'),
              endedAt: new Date('2026-08-05T12:01:00.000Z'),
            },
          }),
        ]}
        {...handlers}
      />,
    )

    expect(markup).toContain('never validated')
    expect(markup).toContain('failed v1')
  })

  it('marks only the bundle whose mutation is in flight as pending', () => {
    const markup = renderToStaticMarkup(
      <BundlesPanel
        bundles={[bundle(), bundle({ id: 'bundle-2', name: 'other-client' })]}
        pendingBundleId="bundle-1"
        {...handlers}
      />,
    )

    // Three disabled controls on the pending card, none on the other.
    expect(markup.match(/disabled=""/g)).toHaveLength(3)
  })

  it('passes an upload refusal to the form rather than swallowing it (FR-031)', () => {
    const markup = renderToStaticMarkup(
      <BundlesPanel
        bundles={[]}
        uploadError={{ code: 'E_BUNDLE_ARCHIVE_NOT_GZIP', action: 'Repackage as a gzipped tar.' }}
        {...handlers}
      />,
    )

    expect(markup).toContain('E_BUNDLE_ARCHIVE_NOT_GZIP')
    expect(markup).toContain('role="alert"')
  })

  it('starts in registration mode, not replacement', () => {
    const markup = renderToStaticMarkup(<BundlesPanel bundles={[bundle()]} {...handlers} />)

    expect(markup).toContain('register a bundle')
    expect(markup).not.toContain('replace archive —')
  })

  it('keeps exactly one primary action on the view', () => {
    const markup = renderToStaticMarkup(
      <BundlesPanel bundles={[bundle(), bundle({ id: 'bundle-2' })]} {...handlers} />,
    )

    expect(markup.match(/text-on-signal/g)).toHaveLength(1)
  })
})
