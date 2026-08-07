'use client'

import { Field } from '@sisyphus-admin/components/ui'

import type { LaunchFieldErrors, LaunchFormValues } from './launch-form-values'
import type { LaunchOption } from './launch-select'
import { LaunchSelect } from './launch-select'

/**
 * What the run checks out — an existing workspace, or a repository typed in (FR-016, FR-129).
 *
 * The two answers are mutually exclusive and the form shows only the one being given. That is not
 * a space saving: a form displaying both would let an admin fill in a repository, choose a
 * workspace, and have no way of knowing which one the launch used. The schema behind it is a
 * discriminated union for the same reason, so the ambiguity has nowhere to live on either side.
 *
 * Only enabled, published workspaces reach the picker (FR-016) — the query behind it filters them
 * — so the form never offers a choice the launch would then refuse.
 */

/** How the two answers are labelled. Ordered with the curated one first. */
const SOURCE_OPTIONS: readonly LaunchOption[] = [
  { value: 'workspace', label: 'A workspace somebody has set up' },
  { value: 'repository', label: 'One repository, entered here' },
]

interface WorkspaceSourceFieldsProps {
  values: LaunchFormValues
  errors: LaunchFieldErrors
  onChange: (patch: Partial<LaunchFormValues>) => void
  /** Enabled, published workspaces. Empty while the query is in flight, or when none exist. */
  workspaces: readonly LaunchOption[]
  disabled?: boolean
}

export const WorkspaceSourceFields = ({
  values,
  errors,
  onChange,
  workspaces,
  disabled = false,
}: WorkspaceSourceFieldsProps) => (
  <div className="gap-default flex flex-col">
    <LaunchSelect
      label="Repositories"
      value={values.workspaceSource}
      options={SOURCE_OPTIONS}
      placeholder="Choose how this run gets its repositories"
      hint="a workspace is versioned and reusable. a repository entered here is kept privately for this run alone"
      disabled={disabled}
      error={errors.workspaceSource}
      onChange={(value) => {
        onChange({ workspaceSource: value === 'repository' ? 'repository' : 'workspace' })
      }}
    />

    {values.workspaceSource === 'workspace' ? (
      <LaunchSelect
        label="Workspace"
        value={values.workspaceVersionId}
        options={workspaces}
        placeholder={
          workspaces.length === 0 ? 'No enabled workspace is available' : 'Choose a workspace'
        }
        hint="the run pins the version shown here, so an edit afterwards leaves it alone"
        disabled={disabled || workspaces.length === 0}
        error={errors.workspaceVersionId}
        onChange={(workspaceVersionId) => {
          onChange({ workspaceVersionId })
        }}
      />
    ) : (
      <>
        <Field
          label="Repository"
          value={values.repositoryUrl}
          placeholder="git@host:org/repo.git"
          disabled={disabled}
          error={errors.repositoryUrl}
          onChange={(event) => {
            onChange({ repositoryUrl: event.target.value })
          }}
        />
        <Field
          label="Base branch"
          value={values.baseBranch}
          placeholder="main"
          disabled={disabled}
          error={errors.baseBranch}
          onChange={(event) => {
            onChange({ baseBranch: event.target.value })
          }}
        />
      </>
    )}
  </div>
)
