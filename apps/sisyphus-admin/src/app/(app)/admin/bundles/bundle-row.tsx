import { Button, Card, CardBody, CardHeader, StateChip } from '@sisyphus-admin/components/ui'

import { abbreviateDigest, formatBytes, formatTimestamp } from './timestamp'
import type { ValidationSummary } from './validation-result'
import { ValidationResult } from './validation-result'

/**
 * One setup bundle, with everything an admin decides from (FR-086, FR-148).
 *
 * Presentational: it holds no state and issues no request, so it renders identically on the server
 * and in a test. Every action arrives as a callback, which is what keeps the panel's data flow in
 * one place instead of spread across rows.
 *
 * The archive's storage key is **not** shown. `bundles.list` does not return one — the executor
 * gets its key from the job envelope, not from a screen — and a key on this card would be a pointer
 * into private encrypted storage rendered for no decision anyone makes here (FR-084). The digest is
 * shown instead, because that is the value an author compares against their own `sha256sum`.
 */

/** The archive currently at the head of a bundle's version history. */
export interface BundleVersionSummary {
  readonly id: string
  readonly version: number
  readonly contentDigest: string
  readonly sizeBytes: number
  readonly registeredAt: Date
}

/**
 * One row's data.
 *
 * These are component props rather than a copy of the procedure's return type: the row renders a
 * name, a flag and a version, and typing it that way lets a test render it without standing up a
 * router.
 */
export interface BundleRowProps {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly enabled: boolean
  /** FR-093. A bundle that cannot enforce a spend cap must say so wherever it is chosen. */
  readonly spendCapsEnforceable: boolean
  /** Absent only for a bundle whose registration did not complete. */
  readonly latestVersion?: BundleVersionSummary
  /** Absent when the bundle has never been validated. Never substituted for a result. */
  readonly latestValidation?: ValidationSummary
  /** True while a mutation for this bundle is in flight. */
  readonly pending?: boolean
  readonly onSetEnabled: (id: string, enabled: boolean) => void
  readonly onReplaceArchive: (id: string) => void
  /** Validation is requested against a **version**, never a bundle — a run proves one archive. */
  readonly onValidate: (setupBundleVersionId: string) => void
}

/** A labelled reading. Label in `label-mono`, value in `data-mono` — the authorship split (FR-026). */
const Reading = ({ label, value, title }: { label: string; value: string; title?: string }) => (
  <div className="gap-hair flex flex-col">
    <span className="type-label-mono text-graphite">{label}</span>
    <span className="type-data-mono text-ink" title={title}>
      {value}
    </span>
  </div>
)

export const BundleRow = ({
  id,
  name,
  description,
  enabled,
  spendCapsEnforceable,
  latestVersion,
  latestValidation,
  pending = false,
  onSetEnabled,
  onReplaceArchive,
  onValidate,
}: BundleRowProps) => (
  <Card aria-label={name}>
    <CardHeader>
      <span>{name}</span>
      {/* The idle chip in both cases: enabled is not a machine state, and colouring it would
          spend a state colour on something that is not one (FR-025). */}
      <StateChip>{enabled ? 'enabled' : 'disabled'}</StateChip>
    </CardHeader>

    <CardBody className="gap-default flex flex-col">
      {description === null ? null : <p className="type-body text-ink">{description}</p>}

      <div className="gap-default flex flex-wrap">
        <Reading
          label="version"
          value={latestVersion === undefined ? 'none' : `v${String(latestVersion.version)}`}
        />
        <Reading
          label="digest"
          value={
            latestVersion === undefined
              ? '—'
              : `sha256 ${abbreviateDigest(latestVersion.contentDigest)}`
          }
          title={latestVersion?.contentDigest}
        />
        <Reading
          label="size"
          value={latestVersion === undefined ? '—' : formatBytes(latestVersion.sizeBytes)}
        />
        <Reading
          label="registered"
          value={latestVersion === undefined ? '—' : formatTimestamp(latestVersion.registeredAt)}
        />
        <Reading
          label="spend caps"
          value={spendCapsEnforceable ? 'enforceable' : 'advisory only'}
        />
      </div>

      <div className="gap-close flex flex-col">
        <span className="type-label-mono text-graphite">latest validation</span>
        <ValidationResult validation={latestValidation} />
      </div>

      <div className="gap-close flex flex-wrap items-center">
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => {
            onSetEnabled(id, !enabled)
          }}
        >
          {enabled ? 'Disable' : 'Enable'}
        </Button>
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => {
            onReplaceArchive(id)
          }}
        >
          Replace archive
        </Button>
        <Button
          variant="quiet"
          disabled={pending || latestVersion === undefined}
          onClick={() => {
            if (latestVersion !== undefined) onValidate(latestVersion.id)
          }}
        >
          Validate
        </Button>
      </div>
    </CardBody>
  </Card>
)
