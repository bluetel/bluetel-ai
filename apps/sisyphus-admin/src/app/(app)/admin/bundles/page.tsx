'use client'

import { describeTrpcError } from '@sisyphus-admin/components/admin'
import { PageHeader } from '@sisyphus-admin/components/shell'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import { FieldError } from '@sisyphus-admin/components/ui'
import type { RouterOutputs } from '@sisyphus-admin/trpc'
import { api } from '@sisyphus-admin/trpc'
import { useState } from 'react'

import type { BundleSummary } from './bundles-panel'
import { BundlesScreen } from './bundles-screen'
import { uploadBundleArchiveAction } from './upload-action'

/**
 * `/admin/bundles` — setup bundle management (T048, FR-086, FR-148).
 *
 * The page is the wiring layer and nothing else: it holds the list query, the four mutations and
 * the one piece of state that says which bundle a mutation is in flight for. Everything visual is
 * in `./bundles-screen`, `./bundles-panel`, `./bundle-row`, `./register-bundle-form` and
 * `./validation-result`, each with a colocated test, so this file holds nothing worth getting
 * wrong except which procedure each handler calls.
 *
 * ## Where the provider went
 *
 * This page used to mount `TRPCReactProvider` itself, because it is `'use client'` — the handlers
 * below call hooks — and the per-screen `AdminShell` that mounted it for the server components was
 * not something a client page could use. `src/app/(app)/layout.tsx` now mounts it once for the
 * whole authenticated group, so the hooks below find a client without this file owning one, and the
 * `<main>` and page column this file used to open belong to that layout too (T156).
 *
 * The admin gate is unchanged and still on the server, in `./layout.tsx`: a client component cannot
 * refuse to render, and the refusal has to be the reason no markup exists rather than a style
 * applied to markup that does (FR-169).
 *
 * ## Registration is two procedures, and the payload says which
 *
 * `onRegistered` fires once the archive is in storage. A payload carrying a `setupBundleId` is a
 * replacement and goes to `replaceArchive`; one without is a first registration and goes to
 * `register`. That branch is the only reason `BundlesScreen` reports the id at all — see its
 * module comment for why the upload and the row write are separate steps.
 *
 * ## Why the list is invalidated rather than patched
 *
 * Every one of these mutations changes something the *list* computes: a registration adds a row, a
 * replacement moves `latestVersion`, `setEnabled` flips a flag, and `validate` opens a run that
 * becomes `latestValidation` with no verdict yet. Writing any of those into the cache by hand
 * would be faster and would be the version that quietly disagrees with the database.
 */

/** One bundle as `admin.bundles.list` returns it. Never a hand-written mirror of that shape. */
type BundleListItem = RouterOutputs['admin']['bundles']['list']['items'][number]

/**
 * Shape a listed bundle into what the row renders.
 *
 * Exported so it is testable without a query client. Two fields are not a pass-through, and they
 * are the reason this is a function rather than a spread: the version's `createdAt` is *when the
 * archive was registered*, which is what the row labels it; and `latestValidation` keeps
 * `undefined` meaning **never validated** rather than being flattened into a null outcome — a null
 * outcome means a run is in flight, and conflating the two would show an unvalidated bundle as
 * validating (FR-148).
 */
export const toBundleSummary = (bundle: BundleListItem): BundleSummary => ({
  id: bundle.id,
  name: bundle.name,
  description: bundle.description,
  enabled: bundle.enabled,
  spendCapsEnforceable: bundle.spendCapsEnforceable,
  ...(bundle.latestVersion === undefined
    ? {}
    : {
        latestVersion: {
          id: bundle.latestVersion.id,
          version: bundle.latestVersion.version,
          contentDigest: bundle.latestVersion.contentDigest,
          sizeBytes: bundle.latestVersion.sizeBytes,
          registeredAt: bundle.latestVersion.createdAt,
        },
      }),
  ...(bundle.latestValidation === undefined
    ? {}
    : {
        latestValidation: {
          version: bundle.latestValidation.version,
          outcome: bundle.latestValidation.outcome,
          startedAt: bundle.latestValidation.startedAt,
          endedAt: bundle.latestValidation.endedAt,
        },
      }),
})

/** The admin sees the whole shelf, disabled bundles included — that is what this screen is for. */
const LIST_INPUT = { limit: 50, enabledOnly: false, includeArchived: false } as const

const BundlesWiring = () => {
  const [pendingBundleId, setPendingBundleId] = useState<string | undefined>(undefined)
  const [error, setError] = useState<FieldErrorContent | undefined>(undefined)

  const utils = api.useUtils()
  const bundles = api.admin.bundles.list.useQuery(LIST_INPUT)

  const settled = () => {
    setPendingBundleId(undefined)
    setError(undefined)
    void utils.admin.bundles.list.invalidate()
  }

  const refused = (failure: unknown) => {
    setPendingBundleId(undefined)
    setError(describeTrpcError(failure))
  }

  const callbacks = { onSuccess: settled, onError: refused }

  const register = api.admin.bundles.register.useMutation()
  const replaceArchive = api.admin.bundles.replaceArchive.useMutation()
  const setEnabled = api.admin.bundles.setEnabled.useMutation()
  const validate = api.admin.bundles.validate.useMutation()

  const items = (bundles.data?.items ?? []).map(toBundleSummary)

  return (
    <>
      {error === undefined ? null : <FieldError {...error} />}

      <BundlesScreen
        uploadArchive={uploadBundleArchiveAction}
        bundles={items}
        loading={bundles.isPending}
        listError={bundles.error === null ? undefined : describeTrpcError(bundles.error)}
        pendingBundleId={pendingBundleId}
        onRegistered={({ archive, values, setupBundleId }) => {
          setError(undefined)

          if (setupBundleId === undefined) {
            register.mutate(
              {
                name: values.name,
                description: values.description === '' ? undefined : values.description,
                spendCapsEnforceable: values.spendCapsEnforceable,
                s3Key: archive.s3Key,
                contentDigest: archive.contentDigest,
                sizeBytes: archive.sizeBytes,
              },
              callbacks,
            )
            return
          }

          setPendingBundleId(setupBundleId)
          replaceArchive.mutate(
            {
              setupBundleId,
              s3Key: archive.s3Key,
              contentDigest: archive.contentDigest,
              sizeBytes: archive.sizeBytes,
            },
            callbacks,
          )
        }}
        onSetEnabled={(setupBundleId, enabled) => {
          setError(undefined)
          setPendingBundleId(setupBundleId)
          setEnabled.mutate({ setupBundleId, enabled }, callbacks)
        }}
        onValidate={(setupBundleVersionId) => {
          setError(undefined)
          validate.mutate({ setupBundleVersionId }, callbacks)
        }}
      />
    </>
  )
}

const BundlesPage = () => (
  <>
    <PageHeader
      eyebrow="Configuration"
      title="Setup bundles"
      summary="A bundle turns a bare instance into one that can do a client’s work. Archives are immutable once registered: replacing one publishes a new version and leaves runs already under way on the version they started with."
    />
    <BundlesWiring />
  </>
)

export default BundlesPage
