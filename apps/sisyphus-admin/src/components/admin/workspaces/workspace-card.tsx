'use client'

import { ChangeNotice, DataReadout, ElapsedReadout } from '@sisyphus-admin/components/admin'
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

import type { WorkspaceReadouts } from './workspace-listing'
import type { WorkspaceNotice } from './workspace-outcome'

/**
 * One workspace, with its version history made visible (T082, FR-125, FR-127, FR-128).
 *
 * ## What the card leads with
 *
 * `v3 of 7`. Not the name, not the repository count — the version. This is the one screen where an
 * admin could reasonably come to believe they are editing the thing runs use, and the first readout
 * on the card is the one that says otherwise: seven versions exist, runs are pinned to whichever
 * one they launched with, and only the third is what a new profile version would pin now.
 *
 * ## Deletion is not offered
 *
 * FR-128 gives disabling instead, because a workspace referenced by an integration or a non-terminal
 * workflow must not be deletable. There is no delete control here to be greyed out, and that is
 * deliberate: a disabled delete button is an invitation to ask why, whereas its absence is the
 * design saying deletion is not part of this system.
 */

interface WorkspaceCardProps {
  workspace: WorkspaceReadouts
  /** The name a clone would take. Held by the panel so this card holds no state. */
  cloneName: string
  onCloneNameChange: (name: string) => void
  onClone: () => void
  onEdit: () => void
  onSetEnabled: (enabled: boolean) => void
  /** `Date.now()` while this card's own change is in flight. */
  startedAt?: number
  error?: FieldErrorContent
  notice?: WorkspaceNotice
}

export const WorkspaceCard = ({
  workspace,
  cloneName,
  onCloneNameChange,
  onClone,
  onEdit,
  onSetEnabled,
  startedAt,
  error,
  notice,
}: WorkspaceCardProps) => {
  const pending = startedAt !== undefined

  return (
    <Card aria-label={`Workspace ${workspace.name}`}>
      <CardHeader>
        <span>{workspace.name}</span>
        <StateChip>{`${workspace.version} · ${workspace.state}`}</StateChip>
      </CardHeader>

      <CardBody className="gap-default flex flex-col">
        <div className="gap-default flex flex-wrap">
          <DataReadout label="pinned version" value={workspace.version} />
          <DataReadout label="version id" value={workspace.currentVersionId} />
          <DataReadout label="published" value={workspace.publishedAt} />
          <DataReadout label="repositories" value={workspace.entryCount} />
          <DataReadout label="description" value={workspace.description} />
        </div>

        <ol className="gap-close flex flex-col">
          {workspace.entries.map((entry) => (
            <li key={entry.id} className="gap-default flex flex-wrap">
              <DataReadout label="repository" value={entry.repositoryUrl} />
              <DataReadout label="branch" value={entry.baseBranch} />
              <DataReadout label="subdirectory" value={entry.subdirectory} />
              <DataReadout label="role" value={entry.role} />
            </li>
          ))}
        </ol>

        <p className="type-body text-graphite measure-prose">
          Editing publishes the next version. A workflow resolves the version it pinned at launch,
          so an edit never changes what a run already under way checks out.
        </p>

        {error === undefined ? null : <FieldError code={error.code} action={error.action} />}

        <div className="gap-close flex flex-wrap items-end">
          <Button variant="secondary" disabled={pending || !workspace.editable} onClick={onEdit}>
            Edit
          </Button>
          {pending ? (
            <Button
              variant="secondary"
              pending
              readout={<ElapsedReadout verb="Working" startedAt={startedAt} />}
            />
          ) : (
            <Button
              variant="secondary"
              onClick={() => {
                onSetEnabled(!workspace.enabled)
              }}
            >
              {workspace.enabled ? 'Disable' : 'Enable'}
            </Button>
          )}
          <Field
            label="Clone as"
            value={cloneName}
            placeholder="name the copy"
            disabled={pending}
            onChange={(event) => {
              onCloneNameChange(event.target.value)
            }}
          />
          <Button
            variant="secondary"
            disabled={pending || cloneName.trim() === ''}
            onClick={onClone}
          >
            Clone
          </Button>
        </div>

        {notice === undefined ? null : (
          <ChangeNotice readout={notice.readout} detail={notice.detail} />
        )}
      </CardBody>
    </Card>
  )
}
