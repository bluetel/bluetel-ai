import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { RegisterBundleForm } from './register-bundle-form'

const noop = () => undefined

describe('RegisterBundleForm', () => {
  it('asks for a name, a description, the spend-cap declaration and an archive', () => {
    const markup = renderToStaticMarkup(<RegisterBundleForm onSubmit={noop} />)

    expect(markup).toContain('Name')
    expect(markup).toContain('Description')
    expect(markup).toContain('Spend caps are enforceable')
    expect(markup).toContain('type="file"')
  })

  it('labels every control above it rather than leaning on a placeholder (FR-031)', () => {
    const markup = renderToStaticMarkup(<RegisterBundleForm onSubmit={noop} />)

    expect(markup).toContain('<label')
    expect(markup).not.toContain('placeholder=')
  })

  it('states the archive format in the label, where an author will read it', () => {
    expect(renderToStaticMarkup(<RegisterBundleForm onSubmit={noop} />)).toContain(
      'gzipped tar with an executable setup.sh at its root',
    )
  })

  it('drops the metadata fields when replacing, so a replacement cannot rename a bundle', () => {
    const markup = renderToStaticMarkup(
      <RegisterBundleForm
        onSubmit={noop}
        replacing={{ id: 'b1', name: 'acme-client', currentVersion: 2 }}
      />,
    )

    expect(markup).not.toContain('Description')
    expect(markup).toContain('acme-client')
    expect(markup).toContain('type="file"')
  })

  it('says which version a replacement will create, and that runs in flight are untouched (FR-090)', () => {
    const markup = renderToStaticMarkup(
      <RegisterBundleForm
        onSubmit={noop}
        replacing={{ id: 'b1', name: 'acme-client', currentVersion: 2 }}
      />,
    )

    expect(markup).toContain('version 3')
    expect(markup).toContain('immutable')
    expect(markup).toContain('keep the version they started with')
  })

  it('shows an error with a machine code and a next action, never a dead end (FR-031)', () => {
    const markup = renderToStaticMarkup(
      <RegisterBundleForm
        onSubmit={noop}
        error={{
          code: 'E_BUNDLE_ARCHIVE_NOT_GZIP',
          action: 'Repackage as a gzipped tar with an executable setup.sh at its root.',
        }}
      />,
    )

    expect(markup).toContain('E_BUNDLE_ARCHIVE_NOT_GZIP')
    expect(markup).toContain('Repackage as a gzipped tar')
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('aria-invalid="true"')
  })

  it('replaces the submit label with a live readout rather than a spinner while uploading', () => {
    const markup = renderToStaticMarkup(<RegisterBundleForm onSubmit={noop} pending />)

    expect(markup).toContain('Uploading archive')
    expect(markup).toContain('aria-busy="true"')
    expect(markup).not.toContain('Register bundle')
    expect(markup).not.toContain('spinner')
  })

  it('disables every control while the upload is in flight', () => {
    const markup = renderToStaticMarkup(<RegisterBundleForm onSubmit={noop} pending />)

    expect(markup.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(4)
  })

  it('offers a way out of the replacement mode only when one was given', () => {
    expect(renderToStaticMarkup(<RegisterBundleForm onSubmit={noop} />)).not.toContain('Cancel')
    expect(
      renderToStaticMarkup(
        <RegisterBundleForm
          onSubmit={noop}
          onCancel={noop}
          replacing={{ id: 'b1', name: 'acme', currentVersion: 1 }}
        />,
      ),
    ).toContain('Cancel')
  })

  it('keeps one primary action, in sentence case, and writes no literal values (SC-015)', () => {
    const markup = renderToStaticMarkup(<RegisterBundleForm onSubmit={noop} onCancel={noop} />)

    // `text-on-signal` is unique to `button-primary`; `bg-signal` also appears in the focus ring.
    expect(markup.match(/text-on-signal/g)).toHaveLength(1)
    expect(markup).toContain('Register bundle')
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="[^"]*\d+px/)
  })
})
