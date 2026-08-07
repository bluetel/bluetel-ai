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
import Link from 'next/link'

import type { EnableFailureNotice } from './enable-refusal'
import type { ProfileReadouts } from './profile-listing'
import type { ProfileNotice } from './profile-outcome'

/**
 * One execution profile, with its version history and its enable gate made visible (T082, FR-124,
 * FR-125, FR-127, FR-128).
 *
 * ## The FR-124 refusal is rendered as a list of field errors
 *
 * The gate collects **every** failing element rather than stopping at the first, so an admin fixing
 * three broken repositories does not discover them one enable attempt at a time. This card keeps
 * that shape: one `field-error` per element, each with its own machine code and its own next
 * action, above the server's own sentence about what is wrong. Flattening them into "could not be
 * enabled" would throw away the only thing that made the check worth performing carefully.
 *
 * ## Deletion is not offered
 *
 * FR-128 gives disabling instead, and there is no delete control here to be greyed out. A disabled
 * delete button invites the question; its absence is the design answering it.
 */

interface ProfileCardProps {
  profile: ProfileReadouts
  /** The name a clone would take. Held by the panel so this card holds no state. */
  cloneName: string
  onCloneNameChange: (name: string) => void
  onClone: () => void
  onEdit: () => void
  onSetEnabled: (enabled: boolean) => void
  /** `Date.now()` while this card's own change is in flight. */
  startedAt?: number
  error?: FieldErrorContent
  /** One entry per element the FR-124 gate refused on (FR-124). */
  enableFailures?: readonly EnableFailureNotice[]
  notice?: ProfileNotice
  /** What still points at this profile, as a sentence. Absent until it has been read. */
  references?: string
  /** Read the reference sweep. Asked for rather than fetched for every card on page load. */
  onShowReferences: () => void
}

export const ProfileCard = ({
  profile,
  cloneName,
  onCloneNameChange,
  onClone,
  onEdit,
  onSetEnabled,
  startedAt,
  error,
  enableFailures = [],
  notice,
  references,
  onShowReferences,
}: ProfileCardProps) => {
  const pending = startedAt !== undefined

  return (
    <Card aria-label={`Execution profile ${profile.name}`}>
      <CardHeader>
        <span>{profile.name}</span>
        <StateChip>{`${profile.version} · ${profile.state}`}</StateChip>
      </CardHeader>

      <CardBody className="gap-default flex flex-col">
        <div className="gap-default flex flex-wrap">
          <DataReadout label="pinned version" value={profile.version} />
          <DataReadout label="version id" value={profile.currentVersionId} />
          <DataReadout label="published" value={profile.publishedAt} />
          <DataReadout label="workspace version" value={profile.workspaceVersionId} />
          <DataReadout label="bundle version" value={profile.setupBundleVersionId} />
          <DataReadout label="type" value={profile.defaultWorkflowType} />
          <DataReadout label="model" value={profile.model} />
          <DataReadout label="instance" value={profile.instanceType} />
          <DataReadout label="capacity" value={profile.purchaseMode} />
          <DataReadout label="turn cap" value={profile.turnCap} />
          <DataReadout label="spend cap" value={profile.spendCap} />
          <DataReadout label="locked fields" value={profile.lockedFields} />
          <DataReadout label="description" value={profile.description} />
          <DataReadout label="preamble" value={profile.promptPreamble} />
        </div>

        {references === undefined ? (
          <div className="flex">
            <Button variant="quiet" disabled={pending} onClick={onShowReferences}>
              What depends on this
            </Button>
          </div>
        ) : (
          <DataReadout label="referenced by" value={references} />
        )}

        <p className="type-body text-graphite measure-prose">
          Editing publishes the next version. A workflow records the profile version it launched
          from, so an edit never changes a run already under way — and the run’s configuration stays
          reconstructable from the version it recorded.
        </p>

        {error === undefined ? null : <FieldError code={error.code} action={error.action} />}

        {enableFailures.length === 0 ? null : (
          <ol className="gap-close flex flex-col" aria-label="Why this profile cannot be enabled">
            {enableFailures.map((failure) => (
              <li key={failure.detail} className="gap-hair flex flex-col">
                <FieldError code={failure.error.code} action={failure.error.action} />
                <p className="type-data-mono text-graphite">{failure.detail}</p>
              </li>
            ))}
          </ol>
        )}

        <div className="gap-close flex flex-wrap items-end">
          <Button variant="secondary" disabled={pending || !profile.editable} onClick={onEdit}>
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
                onSetEnabled(!profile.enabled)
              }}
            >
              {profile.enabled ? 'Disable' : 'Enable'}
            </Button>
          )}
          <Link
            href={`/admin/profiles/${profile.id}/access`}
            className="focus-ring type-data-mono text-signal"
          >
            who holds this profile
          </Link>
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
            disabled={pending || cloneName.trim() === '' || !profile.published}
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
