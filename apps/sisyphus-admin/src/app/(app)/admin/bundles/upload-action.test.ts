import { gzipSync } from 'node:zlib'

import type * as AuthModule from '@sisyphus-admin/lib/auth'
import type * as BundlesModule from '@sisyphus-admin/lib/bundles'
import type { ObjectStore } from '@sisyphus-admin/lib/bundles'
import { sha256Hex } from '@sisyphus-admin/lib/bundles'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ARCHIVE_UPLOAD_FORBIDDEN, ARCHIVE_UPLOAD_NO_FILE } from './archive-upload'

/**
 * The action is wiring: a session gate, an environment read and a call into the upload. Those three
 * are what is asserted here — the upload's own rules have their own suite.
 *
 * The environment and the S3 client are replaced rather than configured, so this suite needs
 * neither a validated environment nor a bucket. Nothing in this file reaches AWS.
 */

const { fakeStore, sessionUser } = vi.hoisted(() => ({
  fakeStore: { store: undefined as ObjectStore | undefined },
  sessionUser: { value: undefined as unknown },
}))

vi.mock('@sisyphus-admin/env', () => ({
  env: { AWS_REGION: 'eu-west-2', SISYPHUS_BUNDLES_BUCKET: 'sisyphus-bundles' },
}))

vi.mock('@sisyphus-admin/lib/auth', async () => {
  const actual = await vi.importActual<typeof AuthModule>('@sisyphus-admin/lib/auth')
  return {
    auth: () => Promise.resolve({ user: sessionUser.value }),
    isAdminSessionUser: actual.isAdminSessionUser,
  }
})

vi.mock('@sisyphus-admin/lib/bundles', async () => {
  const actual = await vi.importActual<typeof BundlesModule>('@sisyphus-admin/lib/bundles')
  return { ...actual, createBundleObjectStore: () => fakeStore.store }
})

const { createFakeObjectStore } = await import('@sisyphus-admin/lib/bundles/fake-object-store')
const { uploadBundleArchiveAction } = await import('./upload-action')

const archiveBytes = new Uint8Array(gzipSync(Buffer.from('#!/bin/sh\nexit 0\n')))

const formWith = (file: File | undefined, name = 'Acme Client'): FormData => {
  const form = new FormData()
  if (file !== undefined) form.set('archive', file)
  form.set('bundleName', name)
  return form
}

const archiveFile = (): File =>
  new File([archiveBytes], 'bundle.tar.gz', { type: 'application/gzip' })

const asAdmin = { id: 'u1', email: 'a@b.test', displayName: 'A', role: 'admin', isActive: true }

beforeEach(() => {
  fakeStore.store = createFakeObjectStore()
  sessionUser.value = asAdmin
})

describe('uploadBundleArchiveAction', () => {
  it('stores the archive and reports the key, digest and size', async () => {
    const result = await uploadBundleArchiveAction(formWith(archiveFile()))

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.archive.contentDigest).toBe(sha256Hex(archiveBytes))
    expect(result.archive.sizeBytes).toBe(archiveBytes.length)
    expect(result.archive.s3Key).toMatch(/^bundles\/acme-client\//)
  })

  it('refuses a caller who is not an admin, before reading the file (FR-167)', async () => {
    sessionUser.value = { ...asAdmin, role: 'engineer' }

    const result = await uploadBundleArchiveAction(formWith(archiveFile()))

    expect(result).toStrictEqual({
      ok: false,
      error: { code: ARCHIVE_UPLOAD_FORBIDDEN, action: expect.any(String) as string },
    })
  })

  it('refuses a deactivated admin, because the session is re-checked per request (FR-175)', async () => {
    sessionUser.value = { ...asAdmin, isActive: false }

    await expect(uploadBundleArchiveAction(formWith(archiveFile()))).resolves.toMatchObject({
      ok: false,
      error: { code: ARCHIVE_UPLOAD_FORBIDDEN },
    })
  })

  it('refuses a request with no session at all', async () => {
    sessionUser.value = undefined

    await expect(uploadBundleArchiveAction(formWith(archiveFile()))).resolves.toMatchObject({
      ok: false,
      error: { code: ARCHIVE_UPLOAD_FORBIDDEN },
    })
  })

  it('writes nothing to storage when the caller is refused', async () => {
    sessionUser.value = { ...asAdmin, role: 'engineer' }
    await uploadBundleArchiveAction(formWith(archiveFile()))

    const store = fakeStore.store as ReturnType<typeof createFakeObjectStore>
    expect(store.puts).toHaveLength(0)
  })

  it('refuses a form carrying no file rather than throwing', async () => {
    await expect(uploadBundleArchiveAction(formWith(undefined))).resolves.toMatchObject({
      ok: false,
      error: { code: ARCHIVE_UPLOAD_NO_FILE },
    })
  })

  it('turns an upload refusal into a coded field error rather than an exception', async () => {
    const notGzip = new File([Uint8Array.from([0x50, 0x4b])], 'bundle.zip')

    await expect(uploadBundleArchiveAction(formWith(notGzip))).resolves.toMatchObject({
      ok: false,
      error: { code: 'E_BUNDLE_ARCHIVE_NOT_GZIP' },
    })
  })
})
