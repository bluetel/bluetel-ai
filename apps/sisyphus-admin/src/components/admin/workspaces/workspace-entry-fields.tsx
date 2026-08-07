'use client'

import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import { Button, Field, FieldError, StateChip } from '@sisyphus-admin/components/ui'

import type { WorkspaceEntryDraft } from './workspace-entry-values'

/**
 * One repository inside a workspace version (T082, FR-109..FR-111).
 *
 * Three values and one role. The role is a button rather than a checkbox, because "primary" is a
 * property of the **list** — exactly one entry has it (FR-110) — and a checkbox per row is a
 * control that can be ticked twice. Pressing this row's button moves the role here; there is no
 * way to express two primaries or none, so there is no invalid state to refuse.
 *
 * Presentational: every value and every callback arrives as a prop.
 */

interface WorkspaceEntryFieldsProps {
  entry: WorkspaceEntryDraft
  /** One-based, as an admin counts repositories and as the FR-124 refusal names them. */
  ordinal: number
  onChange: (patch: Partial<WorkspaceEntryDraft>) => void
  onMakePrimary: () => void
  onRemove: () => void
  /** Whether removing this row is possible — a version must keep at least one repository. */
  removable: boolean
  error?: FieldErrorContent
  disabled?: boolean
}

export const WorkspaceEntryFields = ({
  entry,
  ordinal,
  onChange,
  onMakePrimary,
  onRemove,
  removable,
  error,
  disabled = false,
}: WorkspaceEntryFieldsProps) => (
  <li className="gap-close border-hairline p-close flex flex-col rounded-md border">
    <div className="gap-close flex items-center justify-between">
      <span className="type-label-mono text-graphite">{`repository ${String(ordinal)}`}</span>
      <StateChip>{entry.isPrimary ? 'primary' : 'secondary'}</StateChip>
    </div>

    <Field
      label="Repository"
      value={entry.repositoryUrl}
      placeholder="git@host:org/repo.git"
      disabled={disabled}
      onChange={(event) => {
        onChange({ repositoryUrl: event.target.value })
      }}
    />

    <Field
      label="Base branch"
      value={entry.baseBranch}
      placeholder="main"
      disabled={disabled}
      onChange={(event) => {
        onChange({ baseBranch: event.target.value })
      }}
    />

    <Field
      label="Checkout subdirectory"
      value={entry.subdirectory}
      placeholder="repo"
      disabled={disabled}
      onChange={(event) => {
        onChange({ subdirectory: event.target.value })
      }}
    />

    {error === undefined ? null : <FieldError code={error.code} action={error.action} />}

    <div className="gap-close flex">
      <Button
        variant="secondary"
        disabled={disabled || entry.isPrimary}
        aria-pressed={entry.isPrimary}
        onClick={onMakePrimary}
      >
        Make primary
      </Button>
      <Button variant="danger" disabled={disabled || !removable} onClick={onRemove}>
        Remove
      </Button>
    </div>

    <p className="type-data-mono text-graphite">
      the primary repository is the one skills are resolved from
    </p>
  </li>
)
