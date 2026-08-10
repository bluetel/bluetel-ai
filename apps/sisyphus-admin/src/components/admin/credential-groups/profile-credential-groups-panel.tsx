'use client'

import { ChangeNotice, isNotFoundError, NotFoundCard } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FieldError,
  LoadingState,
  StateChip,
} from '@sisyphus-admin/components/ui'
import type { LaunchOption } from '@sisyphus-admin/components/workflows/new'
import { LaunchSelect } from '@sisyphus-admin/components/workflows/new'
import { api } from '@sisyphus-admin/trpc'
import Link from 'next/link'
import { useState } from 'react'

import { AttachmentGateNotice } from './attachment-gate-notice'
import { canMoveAttachment, moveAttachment } from './attachment-order'
import type { AttachmentNotice } from './attachment-outcome'
import {
  describeAttached,
  describeAttachmentError,
  describeDetached,
  describeReordered,
} from './attachment-outcome'
import { AttachmentRow } from './attachment-row'

/**
 * A profile's ordered credential-group attachments (T027, FR-062, FR-064, FR-065, FR-067).
 *
 * ## Why this is its own screen rather than a section of the profile editor
 *
 * The profile editor publishes a **version**: every value on it is pinned by the version a run
 * records, and editing it mints version n+1 without touching anything already in flight. Attachments
 * are not like that. `profile_credential_groups.execution_profile_id` points at the **mutable**
 * `execution_profiles` row on purpose — the pool a profile draws on is operational capacity rather
 * than part of what a run *does*, and pinning it to a version would both stop a historical run
 * being relaunched once the pool it drew on had been reorganised and mint a version every time
 * somebody added a fallback pool. Putting these controls inside the version editor would tell the
 * administrator the opposite of all of that, in the one place they are most likely to believe it.
 * See `credential-groups.ts` and data-model.md → `profile_credential_groups`.
 *
 * ## The FR-065 refusal is stated here, at configuration time
 *
 * A profile with no usable credential group cannot be enabled, and this panel says so **from the
 * moment the list loads** — not when a save bounces. The whole of FR-065 is that the refusal
 * arrives in front of the person who can fix it, while they are configuring, rather than at launch
 * with a run already accepted; a panel that waited for the administrator to go to the profiles
 * screen, press Enable and read a rejection would have moved the discovery later by exactly the
 * distance the requirement exists to close. The verdict comes from `attachment-gate.ts`, which
 * mirrors the server's rule and never replaces it.
 *
 * ## FR-190 applies to this component, not only to the router
 *
 * The profile id arrives in the URL, so it is the caller's guess. `forProfile` answers `NOT_FOUND`
 * for a profile that does not exist and for one out of scope, identically, and this panel renders
 * that as {@link NotFoundCard} and nothing else.
 */

interface ProfileCredentialGroupsPanelProps {
  executionProfileId: string
}

/** The key an in-flight change and its notice are filed under, so a refusal lands on its own control. */
const ATTACH_KEY = 'attach'

export const ProfileCredentialGroupsPanel = ({
  executionProfileId,
}: ProfileCredentialGroupsPanelProps) => {
  const [chosenGroupId, setChosenGroupId] = useState('')
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined)
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  const [error, setError] = useState<FieldErrorContent | undefined>(undefined)
  const [notice, setNotice] = useState<{ key: string; notice: AttachmentNotice } | undefined>(
    undefined,
  )

  const utils = api.useUtils()
  const attached = api.admin.credentialGroups.forProfile.useQuery({ executionProfileId })
  const groups = api.admin.credentialGroups.list.useQuery({ enabledOnly: true, limit: 50 })

  const attach = api.admin.credentialGroups.attach.useMutation()
  const detach = api.admin.credentialGroups.detach.useMutation()
  const reorder = api.admin.credentialGroups.reorder.useMutation()

  const settle = async (key: string, settled: AttachmentNotice) => {
    setStartedAt(undefined)
    setBusyKey(undefined)
    setError(undefined)
    setNotice({ key, notice: settled })
    await utils.admin.credentialGroups.forProfile.invalidate()
  }

  const refuse = (failure: unknown) => {
    setStartedAt(undefined)
    setError(describeAttachmentError(failure))
  }

  /**
   * Open a change: file it under `key`, start its elapsed readout, and clear whatever the last one
   * said. The clock is read by the caller rather than here, because this function is reachable from
   * the render path and `Date.now()` is not something a render may depend on.
   */
  const begin = (key: string, at: number) => {
    setBusyKey(key)
    setStartedAt(at)
    setError(undefined)
    setNotice(undefined)
  }

  if (isNotFoundError(attached.error)) {
    return <NotFoundCard message="No such execution profile." />
  }

  const attachments = attached.data?.attachments ?? []
  const settled = !attached.isPending && attached.error === null

  const candidates: readonly LaunchOption[] = (groups.data?.items ?? [])
    .filter(
      (group) =>
        group.archivedAt === null &&
        !attachments.some((attachment) => attachment.credentialGroupId === group.id),
    )
    .map((group) => ({
      value: group.id,
      label: `${group.name} — ${String(group.credentialCount)} credential${group.credentialCount === 1 ? '' : 's'}`,
    }))

  return (
    <div className="gap-section flex flex-col">
      <Card>
        <CardHeader>
          <span>credential groups</span>
          <StateChip>
            {attached.isPending ? 'reading' : `attached ${String(attachments.length)}`}
          </StateChip>
        </CardHeader>
        <CardBody className="gap-default flex flex-col">
          <p className="type-body text-graphite measure-prose">
            A run launched from this profile works as an agent credential, and it may only ever be
            given one from a group attached here. The order is a preference order: selection takes
            the first group in this list that has an available credential, and the least recently
            used credential within that group. Attachments are not versioned — changing them changes
            what future runs draw on, and publishes no new version of the profile.
          </p>

          {attached.error === null ? null : (
            <FieldError {...describeAttachmentError(attached.error)} />
          )}

          {attached.isPending ? (
            <LoadingState>reading this profile’s credential groups</LoadingState>
          ) : null}

          {/*
            FR-065, stated at configuration time. Rendered from the attachments themselves the
            moment they are read — no mutation attempted, nothing pressed — because the requirement
            is that the administrator meets this refusal while configuring rather than when a save
            bounces or, worse, when a run has already been accepted. Gated on `settled` only so
            that a list which has not answered yet is not reported as an empty one.
          */}
          {settled ? <AttachmentGateNotice attachments={attachments} /> : null}

          {settled && attachments.length === 0 ? (
            <EmptyState>no credential group is attached to this execution profile</EmptyState>
          ) : null}

          <ol
            className="gap-default flex flex-col"
            aria-label="Attached credential groups, in preference order"
          >
            {attachments.map((attachment) => (
              <AttachmentRow
                key={attachment.id}
                attachment={attachment}
                total={attachments.length}
                canMoveEarlier={canMoveAttachment(
                  attachments,
                  attachment.credentialGroupId,
                  'earlier',
                )}
                canMoveLater={canMoveAttachment(attachments, attachment.credentialGroupId, 'later')}
                startedAt={busyKey === attachment.credentialGroupId ? startedAt : undefined}
                error={busyKey === attachment.credentialGroupId ? error : undefined}
                onMove={(move) => {
                  // The whole order is sent, built from the rows this panel last read — the
                  // router refuses one that disagrees with what is attached, which turns a
                  // concurrent attach into a reload rather than into a silent reshuffle.
                  const order = moveAttachment(attachments, attachment.credentialGroupId, move)
                  if (order === undefined) return

                  begin(attachment.credentialGroupId, Date.now())
                  reorder.mutate(
                    { executionProfileId, credentialGroupIds: [...order] },
                    {
                      onSuccess: (result) => {
                        void settle(attachment.credentialGroupId, describeReordered(result))
                      },
                      onError: refuse,
                    },
                  )
                }}
                onDetach={() => {
                  begin(attachment.credentialGroupId, Date.now())
                  detach.mutate(
                    { executionProfileId, credentialGroupId: attachment.credentialGroupId },
                    {
                      onSuccess: (result) => {
                        void settle(
                          attachment.credentialGroupId,
                          describeDetached(result, attachment.name),
                        )
                      },
                      onError: refuse,
                    },
                  )
                }}
              />
            ))}
          </ol>

          <LaunchSelect
            label="Attach a credential group"
            value={chosenGroupId}
            options={candidates}
            placeholder={
              candidates.length === 0
                ? 'Every enabled group is already attached'
                : 'Choose a group to attach'
            }
            hint="attached last in preference order — move it earlier if a run should prefer it"
            disabled={busyKey === ATTACH_KEY || candidates.length === 0}
            error={busyKey === ATTACH_KEY ? error : undefined}
            onChange={(value) => {
              setChosenGroupId(value)
              setError(undefined)
              setNotice(undefined)
            }}
          />

          <div className="gap-close flex flex-wrap items-center">
            <Button
              variant="primary"
              disabled={chosenGroupId === '' || busyKey === ATTACH_KEY}
              onClick={() => {
                const name =
                  (groups.data?.items ?? []).find((group) => group.id === chosenGroupId)?.name ?? ''

                begin(ATTACH_KEY, Date.now())
                attach.mutate(
                  { executionProfileId, credentialGroupId: chosenGroupId },
                  {
                    onSuccess: (result) => {
                      setChosenGroupId('')
                      void settle(ATTACH_KEY, describeAttached(result, name))
                    },
                    onError: refuse,
                  },
                )
              }}
            >
              Attach group
            </Button>
            <Link
              href="/admin/credentials/groups"
              className="focus-ring type-data-mono text-signal"
            >
              manage credential groups
            </Link>
          </div>

          {notice === undefined ? null : (
            <ChangeNotice readout={notice.notice.readout} detail={notice.notice.detail} />
          )}
        </CardBody>
      </Card>
    </div>
  )
}
