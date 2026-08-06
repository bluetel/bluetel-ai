import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { BundleRowProps } from './bundle-row'
import { BundleRow } from './bundle-row'

const DIGEST = '9f'.repeat(32)

const props = (overrides: Partial<BundleRowProps> = {}): BundleRowProps => ({
  id: 'bundle-1',
  name: 'acme-client',
  description: 'Installs the agent CLI and the client’s repository credentials.',
  enabled: true,
  spendCapsEnforceable: true,
  latestVersion: {
    id: 'version-1',
    version: 3,
    contentDigest: DIGEST,
    sizeBytes: 2 * 1024 * 1024,
    registeredAt: new Date('2026-08-05T10:15:00.000Z'),
  },
  onSetEnabled: () => undefined,
  onReplaceArchive: () => undefined,
  onValidate: () => undefined,
  ...overrides,
})

describe('BundleRow', () => {
  it('names the bundle and reports whether it is enabled', () => {
    const markup = renderToStaticMarkup(<BundleRow {...props()} />)

    expect(markup).toContain('acme-client')
    expect(markup).toContain('enabled')
  })

  it('offers Disable for an enabled bundle and Enable for a disabled one (FR-092)', () => {
    expect(renderToStaticMarkup(<BundleRow {...props()} />)).toContain('Disable')
    expect(renderToStaticMarkup(<BundleRow {...props({ enabled: false })} />)).toContain('Enable')
  })

  it('offers no delete — a referenced bundle is disabled, never removed (FR-092)', () => {
    const markup = renderToStaticMarkup(<BundleRow {...props()} />)

    expect(markup).not.toContain('Delete')
    expect(markup).not.toContain('Remove')
  })

  it('shows the current version, its size and when it was registered', () => {
    const markup = renderToStaticMarkup(<BundleRow {...props()} />)

    expect(markup).toContain('v3')
    expect(markup).toContain('2.0 MiB')
    expect(markup).toContain('2026-08-05 10:15 UTC')
  })

  it('abbreviates the digest on screen but keeps the whole value available', () => {
    const markup = renderToStaticMarkup(<BundleRow {...props()} />)

    // An operator comparing against `sha256sum` needs all 64 characters; a truncated string
    // presented as complete would be worse than showing none.
    expect(markup).toContain(`title="${DIGEST}"`)
    expect(markup).toContain('9f9f9f9f9f9f…')
  })

  it('never shows the archive’s storage key (FR-084)', () => {
    const markup = renderToStaticMarkup(<BundleRow {...props()} />)

    expect(markup).not.toContain('bundles/')
    expect(markup).not.toContain('s3')
  })

  it('says plainly when a bundle’s spend caps are only advisory (FR-093)', () => {
    expect(
      renderToStaticMarkup(<BundleRow {...props({ spendCapsEnforceable: false })} />),
    ).toContain('advisory only')
    expect(renderToStaticMarkup(<BundleRow {...props()} />)).toContain('enforceable')
  })

  it('renders the latest validation, and "never validated" when there is none (FR-148)', () => {
    expect(renderToStaticMarkup(<BundleRow {...props()} />)).toContain('never validated')

    const validated = renderToStaticMarkup(
      <BundleRow
        {...props({
          latestValidation: {
            version: 3,
            outcome: 'passed',
            startedAt: new Date('2026-08-05T11:00:00.000Z'),
            endedAt: new Date('2026-08-05T11:02:00.000Z'),
          },
        })}
      />,
    )
    expect(validated).toContain('passed v3')
    expect(validated).not.toContain('never validated')
  })

  it('cannot ask for a validation of a bundle with no archive', () => {
    const markup = renderToStaticMarkup(<BundleRow {...props({ latestVersion: undefined })} />)

    expect(markup).toContain('disabled=""')
    expect(markup).toContain('none')
  })

  it('disables every action while one is in flight', () => {
    const markup = renderToStaticMarkup(<BundleRow {...props({ pending: true })} />)

    expect(markup.match(/disabled=""/g)).toHaveLength(3)
  })

  it('is a card with a hairline rather than a shadow, and writes no literal values (SC-015)', () => {
    const markup = renderToStaticMarkup(<BundleRow {...props()} />)

    expect(markup).toContain('border-hairline')
    expect(markup).not.toMatch(/shadow-(?!none|keycap)/)
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="[^"]*\d+px/)
  })
})
