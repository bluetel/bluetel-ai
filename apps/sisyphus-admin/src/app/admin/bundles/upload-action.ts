'use server'

import { env } from '@sisyphus-admin/env'
import { auth, isAdminSessionUser } from '@sisyphus-admin/lib/auth'
import { createBundleObjectStore, uploadBundleArchive } from '@sisyphus-admin/lib/bundles'

import type { ArchiveUploadResult } from './archive-upload'
import {
  ARCHIVE_UPLOAD_FORBIDDEN,
  ARCHIVE_UPLOAD_NO_FILE,
  describeUploadFailure,
  uploadFailureCode,
} from './archive-upload'

/**
 * Put a submitted archive into encrypted private storage and report the key, digest and size
 * (T045, FR-084).
 *
 * A server action rather than a browser-side upload, and that is the security boundary rather than
 * a convenience: a presigned URL handed to the browser would let whoever holds it write into the
 * bundles bucket, and a bundle is arbitrary shell that runs with the instance's privileges
 * (contracts/setup-bundle.md). The bytes therefore pass through a request that has already
 * established an **active admin session** — the same gate `adminProcedure` applies, applied here
 * because this write does not go through the router.
 *
 * The action is wiring only. Everything that can be got wrong — the digest, the key, the refusal to
 * overwrite — is in `@sisyphus-admin/lib/bundles` with its own tests, and the message table is in
 * `./archive-upload`.
 */
export const uploadBundleArchiveAction = async (form: FormData): Promise<ArchiveUploadResult> => {
  const session = await auth()

  if (!isAdminSessionUser(session?.user)) {
    return { ok: false, error: describeUploadFailure(ARCHIVE_UPLOAD_FORBIDDEN) }
  }

  const archive = form.get('archive')
  const bundleName = form.get('bundleName')

  if (!(archive instanceof File)) {
    return { ok: false, error: describeUploadFailure(ARCHIVE_UPLOAD_NO_FILE) }
  }

  try {
    const uploaded = await uploadBundleArchive({
      store: createBundleObjectStore(env.AWS_REGION),
      bucket: env.SISYPHUS_BUNDLES_BUCKET,
      bundleName: typeof bundleName === 'string' ? bundleName : archive.name,
      bytes: new Uint8Array(await archive.arrayBuffer()),
    })

    return { ok: true, archive: uploaded }
  } catch (error) {
    return { ok: false, error: describeUploadFailure(uploadFailureCode(error)) }
  }
}
