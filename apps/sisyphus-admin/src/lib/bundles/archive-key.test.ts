import { describe, expect, it } from 'vitest'

import {
  BUNDLE_ARCHIVE_PREFIX,
  BUNDLE_ARCHIVE_SUFFIX,
  bundleArchiveKey,
  bundleNameSlug,
} from './archive-key'

const DIGEST = 'a'.repeat(64)

describe('bundleNameSlug', () => {
  it('lower-cases and dashes a human name', () => {
    expect(bundleNameSlug('Acme Client Bundle')).toBe('acme-client-bundle')
  })

  it('collapses a run of separators rather than leaving empty segments', () => {
    expect(bundleNameSlug('acme   ///   client')).toBe('acme-client')
  })

  it('cannot steer the key out of its prefix', () => {
    // A name is operator-supplied text. `..` and `/` in it must not become path structure.
    expect(bundleNameSlug('../../etc/passwd')).toBe('etc-passwd')
    expect(bundleNameSlug('a/b')).not.toContain('/')
  })

  it('never yields an empty segment, which would produce a double slash', () => {
    expect(bundleNameSlug('///')).toBe('bundle')
    expect(bundleNameSlug('')).toBe('bundle')
  })

  it('bounds the slug so one long name cannot dominate the key', () => {
    expect(bundleNameSlug('x'.repeat(200)).length).toBeLessThanOrEqual(48)
  })
})

describe('bundleArchiveKey', () => {
  it('sits under the archive prefix and carries the archive suffix', () => {
    const key = bundleArchiveKey({ bundleName: 'Acme', contentDigest: DIGEST, uploadId: 'u1' })

    expect(key.startsWith(`${BUNDLE_ARCHIVE_PREFIX}/`)).toBe(true)
    expect(key.endsWith(BUNDLE_ARCHIVE_SUFFIX)).toBe(true)
    expect(key).toBe(`bundles/acme/u1-${DIGEST}.tar.gz`)
  })

  it('carries the digest, so two different archives can never share a key', () => {
    const first = bundleArchiveKey({ bundleName: 'Acme', contentDigest: 'a'.repeat(64) })
    const second = bundleArchiveKey({ bundleName: 'Acme', contentDigest: 'b'.repeat(64) })

    expect(first).not.toBe(second)
  })

  it('differs between two uploads of the *same* bytes (FR-090)', () => {
    // This is the property that makes overwriting impossible. A key derived only from the bundle
    // and its contents would be stable across re-registrations, and re-registering the same
    // archive would put version 2 exactly where version 1 lives.
    const first = bundleArchiveKey({ bundleName: 'Acme', contentDigest: DIGEST })
    const second = bundleArchiveKey({ bundleName: 'Acme', contentDigest: DIGEST })

    expect(first).not.toBe(second)
  })

  it('offers no stable alias a caller could resolve or overwrite', () => {
    const key = bundleArchiveKey({ bundleName: 'Acme', contentDigest: DIGEST })

    expect(key).not.toContain('latest')
    expect(key).not.toContain('current')
  })
})
