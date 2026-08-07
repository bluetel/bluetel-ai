import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { ArchiveUploadResult } from './archive-upload'
import { BundlesScreen } from './bundles-screen'

const neverCalled = (): Promise<ArchiveUploadResult> => {
  throw new Error('The upload must not run during a static render.')
}

const props = {
  uploadArchive: neverCalled,
  onRegistered: () => undefined,
  onSetEnabled: () => undefined,
  onValidate: () => undefined,
}

describe('BundlesScreen', () => {
  it('renders the panel with nothing in flight and no error', () => {
    const markup = renderToStaticMarkup(<BundlesScreen {...props} />)

    expect(markup).toContain('register a bundle')
    expect(markup).toContain('Register bundle')
    expect(markup).not.toContain('Uploading archive')
    expect(markup).not.toContain('role="alert"')
  })

  it('defaults to an empty list rather than to invented rows', () => {
    expect(renderToStaticMarkup(<BundlesScreen {...props} />)).toContain(
      'No setup bundles are registered yet',
    )
  })

  it('does not upload anything just by rendering', () => {
    // `neverCalled` throws, so this passing is the assertion: the action runs on submit only.
    expect(() => renderToStaticMarkup(<BundlesScreen {...props} />)).not.toThrow()
  })

  it('passes the list through to the panel', () => {
    const markup = renderToStaticMarkup(
      <BundlesScreen
        {...props}
        bundles={[
          {
            id: 'b1',
            name: 'acme-client',
            description: null,
            enabled: false,
            spendCapsEnforceable: false,
            latestVersion: {
              id: 'v1',
              version: 2,
              contentDigest: 'cd'.repeat(32),
              sizeBytes: 2048,
              registeredAt: new Date('2026-08-05T10:00:00.000Z'),
            },
          },
        ]}
      />,
    )

    expect(markup).toContain('acme-client')
    expect(markup).toContain('v2')
    expect(markup).toContain('never validated')
  })
})
