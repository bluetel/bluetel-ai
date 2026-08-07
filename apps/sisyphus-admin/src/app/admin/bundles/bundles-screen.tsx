'use client'

import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import { useState } from 'react'

import type { ArchiveUploadResult, UploadedArchive } from './archive-upload'
import type { BundleSummary } from './bundles-panel'
import { BundlesPanel } from './bundles-panel'
import type { BundleFormValues } from './register-bundle-form'

/**
 * The client container: it turns a submitted form into an upload, and hands the stored archive on.
 *
 * ## Why the upload and the registration are two steps
 *
 * `admin.bundles.register` takes a key, a digest and a size — not a file. That split is deliberate:
 * the digest recorded against a version has to be the digest of the bytes that reached storage
 * (contracts/setup-bundle.md), so the upload happens first, reports what it stored, and only then
 * is a row written. A procedure that accepted the file would have to re-derive the digest on the
 * far side of a second transfer, and any mismatch between the two would surface as a
 * `bundle_verify` failure on a paid instance rather than as a failed upload.
 *
 * ## What is injected, and why
 *
 * `uploadArchive` and `onRegistered` arrive as props. The upload is a server action — the bytes
 * must pass through a request holding an active admin session, because a presigned URL handed to
 * the browser would let its holder write arbitrary shell into the bundles bucket. `onRegistered`
 * is where `admin.bundles.register` / `replaceArchive` are called; it is a prop so a test can render this component without a query client, and so the panel screen does not have to know
 * which of the two procedures a submission maps to.
 */

export interface BundlesScreenProps {
  readonly bundles?: readonly BundleSummary[]
  readonly loading?: boolean
  readonly pendingBundleId?: string
  /** The server action. Injected so the screen can be exercised against a stub. */
  readonly uploadArchive: (form: FormData) => Promise<ArchiveUploadResult>
  /**
   * Called once the archive is in storage. `setupBundleId` is present for a replacement and absent
   * for a first registration, which is exactly the difference between the two procedures.
   */
  readonly onRegistered: (input: {
    readonly archive: UploadedArchive
    readonly values: BundleFormValues
    readonly setupBundleId?: string
  }) => void | Promise<void>
  readonly onSetEnabled: (setupBundleId: string, enabled: boolean) => void
  readonly onValidate: (setupBundleVersionId: string) => void
}

/** Build the multipart payload the server action reads. */
const toFormData = (values: BundleFormValues): FormData => {
  const form = new FormData()
  form.set('archive', values.archive)
  form.set('bundleName', values.name)
  return form
}

export const BundlesScreen = ({
  bundles = [],
  loading = false,
  pendingBundleId,
  uploadArchive,
  onRegistered,
  onSetEnabled,
  onValidate,
}: BundlesScreenProps) => {
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<FieldErrorContent | undefined>(undefined)

  const submit = (values: BundleFormValues, setupBundleId?: string): void => {
    setUploading(true)
    setUploadError(undefined)

    void uploadArchive(toFormData(values))
      .then(async (result) => {
        if (!result.ok) {
          setUploadError(result.error)
          return
        }
        await onRegistered({ archive: result.archive, values, setupBundleId })
      })
      .finally(() => {
        setUploading(false)
      })
  }

  return (
    <BundlesPanel
      bundles={bundles}
      loading={loading}
      pendingBundleId={pendingBundleId}
      uploading={uploading}
      uploadError={uploadError}
      onSetEnabled={onSetEnabled}
      onValidate={onValidate}
      onRegister={(values) => {
        submit(values)
      }}
      onReplace={(setupBundleId, values) => {
        submit(values, setupBundleId)
      }}
    />
  )
}
