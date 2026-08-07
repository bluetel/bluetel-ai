'use client'

import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FieldError,
  LoadingState,
} from '@sisyphus-admin/components/ui'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import { useState } from 'react'

import type { BundleRowProps } from './bundle-row'
import { BundleRow } from './bundle-row'
import type { BundleFormValues } from './register-bundle-form'
import { RegisterBundleForm } from './register-bundle-form'

/**
 * The bundle management screen (T048, FR-086, FR-148).
 *
 * Register, replace, enable, disable, validate, and each bundle's most recent validation result.
 *
 * It owns exactly one piece of state — which bundle, if any, is being replaced — and takes
 * everything else as props. So a test can render the whole screen without a router, a query client
 * or a browser, which is what makes the FR-148 rules ("never validated" is shown as such)
 * and the FR-093 rule (an unenforceable spend cap is stated) testable at all.
 */

/** One bundle's data, without the handlers the panel supplies. */
export type BundleSummary = Omit<
  BundleRowProps,
  'onSetEnabled' | 'onReplaceArchive' | 'onValidate' | 'pending'
>

export interface BundlesPanelProps {
  readonly bundles: readonly BundleSummary[]
  /** True while the list itself is being fetched, as distinct from being empty. */
  readonly loading?: boolean
  /**
   * A refusal from the **list** read, as distinct from {@link BundlesPanelProps.uploadError}, which
   * belongs to a submission. Without it a failed list rendered "no setup bundles are registered
   * yet" — a claim about the shelf, made by a screen that had not managed to look at it.
   */
  readonly listError?: FieldErrorContent
  /** The bundle a mutation is currently in flight for. */
  readonly pendingBundleId?: string
  readonly uploading?: boolean
  readonly uploadError?: FieldErrorContent
  readonly onRegister: (values: BundleFormValues) => void
  readonly onReplace: (setupBundleId: string, values: BundleFormValues) => void
  readonly onSetEnabled: (setupBundleId: string, enabled: boolean) => void
  readonly onValidate: (setupBundleVersionId: string) => void
}

export const BundlesPanel = ({
  bundles,
  loading = false,
  listError,
  pendingBundleId,
  uploading = false,
  uploadError,
  onRegister,
  onReplace,
  onSetEnabled,
  onValidate,
}: BundlesPanelProps) => {
  const [replacingId, setReplacingId] = useState<string | undefined>(undefined)
  const replacing = bundles.find((bundle) => bundle.id === replacingId)

  const handleSubmit = (values: BundleFormValues): void => {
    if (replacing === undefined) {
      onRegister(values)
      return
    }
    onReplace(replacing.id, values)
    setReplacingId(undefined)
  }

  return (
    <div className="gap-section flex flex-col">
      <RegisterBundleForm
        pending={uploading}
        error={uploadError}
        onSubmit={handleSubmit}
        replacing={
          replacing === undefined
            ? undefined
            : {
                id: replacing.id,
                name: replacing.name,
                currentVersion: replacing.latestVersion?.version ?? 0,
              }
        }
        onCancel={
          replacing === undefined
            ? undefined
            : () => {
                setReplacingId(undefined)
              }
        }
      />

      {bundles.length === 0 ? (
        <Card aria-label="Setup bundles">
          <CardHeader>
            <span>setup bundles</span>
          </CardHeader>
          <CardBody className="gap-default flex flex-col">
            {listError === undefined ? null : (
              <FieldError {...listError} className="measure-prose" />
            )}

            {loading ? <LoadingState>reading the bundle list</LoadingState> : null}

            {loading || listError !== undefined ? null : (
              <EmptyState>
                no setup bundles are registered yet — register one above to make it selectable in an
                execution profile
              </EmptyState>
            )}
          </CardBody>
        </Card>
      ) : (
        <div className="gap-default flex flex-col">
          {bundles.map((bundle) => (
            <BundleRow
              key={bundle.id}
              {...bundle}
              pending={bundle.id === pendingBundleId}
              onSetEnabled={onSetEnabled}
              onValidate={onValidate}
              onReplaceArchive={setReplacingId}
            />
          ))}
        </div>
      )}
    </div>
  )
}
