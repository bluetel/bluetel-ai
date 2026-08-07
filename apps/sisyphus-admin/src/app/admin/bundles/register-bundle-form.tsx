'use client'

import { Button, Card, CardBody, CardHeader, Field } from '@sisyphus-admin/components/ui'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import type { SyntheticEvent } from 'react'

/**
 * Register a bundle, or publish a new archive for one (FR-086, FR-090).
 *
 * One component for both, because they are the same act with different amounts of metadata: a
 * registration names the bundle and declares whether its credential can enforce a spend cap; a
 * replacement supplies only an archive, since editing metadata is `updateMetadata` and mixing the
 * two would be a form that could silently rename a bundle while replacing its contents.
 *
 * The form reports what will happen in the replacement case rather than leaving it implied. "This
 * creates version N+1; the archive in use by runs already under way is untouched" is the property
 * FR-090 exists to provide, and an admin who does not know it is true will avoid replacing a
 * bundle while anything is running.
 *
 * Presentational: it validates nothing beyond "a file was chosen" and holds no request state. The
 * archive checks that matter — gzip, size, digest — belong to the upload, where they are the same
 * checks whatever called it.
 */

export interface BundleFormValues {
  readonly name: string
  readonly description: string
  readonly spendCapsEnforceable: boolean
  readonly archive: File
}

/** The bundle a replacement is for. Omitted when registering a new one. */
export interface ReplacementTarget {
  readonly id: string
  readonly name: string
  /** The version this replacement will follow. */
  readonly currentVersion: number
}

interface RegisterBundleFormProps {
  readonly replacing?: ReplacementTarget
  readonly pending?: boolean
  readonly error?: FieldErrorContent
  readonly onSubmit: (values: BundleFormValues) => void
  /** Offered only while replacing, so an admin can back out of the mode they switched into. */
  readonly onCancel?: () => void
}

const FIELD_NAMES = {
  name: 'bundleName',
  description: 'bundleDescription',
  spendCaps: 'spendCapsEnforceable',
  archive: 'archive',
} as const

/** Read a single text value out of the submitted form. */
const readText = (form: FormData, field: string): string => {
  const value = form.get(field)
  return typeof value === 'string' ? value.trim() : ''
}

export const RegisterBundleForm = ({
  replacing,
  pending = false,
  error,
  onSubmit,
  onCancel,
}: RegisterBundleFormProps) => {
  const isReplacement = replacing !== undefined

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const archive = form.get(FIELD_NAMES.archive)

    if (!(archive instanceof File)) {
      return
    }

    onSubmit({
      name: isReplacement ? replacing.name : readText(form, FIELD_NAMES.name),
      description: isReplacement ? '' : readText(form, FIELD_NAMES.description),
      spendCapsEnforceable: !isReplacement && form.get(FIELD_NAMES.spendCaps) !== null,
      archive,
    })
  }

  return (
    <Card aria-label={isReplacement ? 'Replace archive' : 'Register a setup bundle'}>
      <CardHeader>
        <span>{isReplacement ? `replace archive — ${replacing.name}` : 'register a bundle'}</span>
      </CardHeader>

      <CardBody>
        <form className="gap-default flex flex-col" onSubmit={handleSubmit}>
          {isReplacement ? (
            <p className="type-body text-ink">
              {`Publishes version ${String(replacing.currentVersion + 1)}. The archive is immutable
                once registered, so runs already under way keep the version they started with.`}
            </p>
          ) : (
            <>
              <Field
                label="Name"
                name={FIELD_NAMES.name}
                required
                disabled={pending}
                autoComplete="off"
              />
              <Field
                label="Description"
                name={FIELD_NAMES.description}
                disabled={pending}
                autoComplete="off"
              />
              <Field
                label="Spend caps are enforceable under this bundle's credential"
                name={FIELD_NAMES.spendCaps}
                type="checkbox"
                disabled={pending}
              />
            </>
          )}

          <Field
            label="Archive (gzipped tar with an executable setup.sh at its root)"
            name={FIELD_NAMES.archive}
            type="file"
            accept=".gz,.tgz,application/gzip"
            required
            disabled={pending}
            error={error}
          />

          <div className="gap-close flex items-center">
            {pending ? (
              <Button variant="primary" type="submit" pending readout="Uploading archive" />
            ) : (
              <Button variant="primary" type="submit">
                {isReplacement ? 'Publish new version' : 'Register bundle'}
              </Button>
            )}
            {onCancel === undefined ? null : (
              <Button variant="quiet" disabled={pending} onClick={onCancel}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      </CardBody>
    </Card>
  )
}
