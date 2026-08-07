'use client'

import { ChangeNotice, ElapsedReadout } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  FieldError,
  StateChip,
} from '@sisyphus-admin/components/ui'

import { WorkspaceEntryFields } from './workspace-entry-fields'
import type {
  WorkspaceDraft,
  WorkspaceDraftErrors,
  WorkspaceEntryDraft,
} from './workspace-entry-values'
import { EMPTY_ENTRY, withoutEntryAt, withPrimaryAt } from './workspace-entry-values'
import type { WorkspaceNotice } from './workspace-outcome'

/**
 * The workspace editor — one form for creating and for editing (T082, FR-125, FR-127).
 *
 * ## The submit button says what it will do
 *
 * `Create workspace` and `Publish version 4` are different acts and the button is the last place an
 * admin looks before performing one. A button that said `Save` on both would be the screen quietly
 * asserting that editing mutates the thing runs are using, which is precisely the model FR-125
 * exists to prevent anyone holding.
 *
 * Presentational: every value, every refusal and every callback arrives as a prop, so this renders
 * without a tRPC provider.
 */

interface WorkspaceEditorProps {
  /** `undefined` when creating; the next version number when editing an existing workspace. */
  nextVersion?: number
  draft: WorkspaceDraft
  errors: WorkspaceDraftErrors
  onChange: (patch: Partial<WorkspaceDraft>) => void
  onSubmit: () => void
  onCancel?: () => void
  /** `Date.now()` when the change was submitted, or `undefined` when nothing is in flight. */
  startedAt?: number
  error?: FieldErrorContent
  notice?: WorkspaceNotice
}

export const WorkspaceEditor = ({
  nextVersion,
  draft,
  errors,
  onChange,
  onSubmit,
  onCancel,
  startedAt,
  error,
  notice,
}: WorkspaceEditorProps) => {
  const pending = startedAt !== undefined
  const editing = nextVersion !== undefined

  const patchEntry = (index: number, patch: Partial<WorkspaceEntryDraft>) => {
    onChange({
      entries: draft.entries.map((entry, position) =>
        position === index ? { ...entry, ...patch } : entry,
      ),
    })
  }

  return (
    <Card>
      <CardHeader>
        <span>{editing ? 'publish a new version' : 'new workspace'}</span>
        <StateChip>{`repositories ${String(draft.entries.length)}`}</StateChip>
      </CardHeader>
      <CardBody className="gap-default flex flex-col">
        <p className="type-body text-graphite measure-prose">
          {editing
            ? `Editing does not change this workspace. It publishes version ${String(nextVersion)} with the repositories below, and every workflow already running stays on the version it pinned when it launched.`
            : 'A workspace is the repository set a run checks out. It arrives disabled, so an unreviewed set cannot become selectable the moment it is typed in.'}
        </p>

        <Field
          label="Name"
          value={draft.name}
          placeholder="Payments"
          disabled={pending}
          error={errors.name}
          onChange={(event) => {
            onChange({ name: event.target.value })
          }}
        />

        <Field
          label="Description"
          value={draft.description}
          placeholder="optional"
          disabled={pending}
          error={errors.description}
          onChange={(event) => {
            onChange({ description: event.target.value })
          }}
        />

        <ol className="gap-close flex flex-col">
          {draft.entries.map((entry, index) => (
            <WorkspaceEntryFields
              key={index}
              entry={entry}
              ordinal={index + 1}
              disabled={pending}
              removable={draft.entries.length > 1}
              error={errors.rows?.[index]}
              onChange={(patch) => {
                patchEntry(index, patch)
              }}
              onMakePrimary={() => {
                onChange({ entries: withPrimaryAt(draft.entries, index) })
              }}
              onRemove={() => {
                onChange({ entries: withoutEntryAt(draft.entries, index) })
              }}
            />
          ))}
        </ol>

        {errors.entries === undefined ? null : <FieldError {...errors.entries} />}

        <div className="flex">
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => {
              onChange({ entries: [...draft.entries, EMPTY_ENTRY] })
            }}
          >
            Add a repository
          </Button>
        </div>

        {error === undefined ? null : <FieldError code={error.code} action={error.action} />}

        <div className="gap-close flex">
          {pending ? (
            <Button
              variant="primary"
              pending
              readout={<ElapsedReadout verb="Publishing" startedAt={startedAt} />}
            />
          ) : (
            <Button variant="primary" onClick={onSubmit}>
              {editing ? `Publish version ${String(nextVersion)}` : 'Create workspace'}
            </Button>
          )}
          {onCancel === undefined ? null : (
            <Button variant="quiet" disabled={pending} onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>

        {notice === undefined ? null : (
          <ChangeNotice readout={notice.readout} detail={notice.detail} />
        )}
      </CardBody>
    </Card>
  )
}
