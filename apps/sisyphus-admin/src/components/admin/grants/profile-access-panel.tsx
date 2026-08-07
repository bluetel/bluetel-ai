'use client'

import { NotFoundCard } from '@sisyphus-admin/components/admin/not-found-card'
import { isNotFoundError } from '@sisyphus-admin/components/admin/trpc-error'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FieldError,
  LoadingState,
  StateChip,
} from '@sisyphus-admin/components/ui'
import { api } from '@sisyphus-admin/trpc'
import { useState } from 'react'

import { liveGrantHolderIds } from './grant-listing'
import { GrantRow } from './grant-row'
import { IssueGrantForm } from './issue-grant-form'
import type { GrantNotice } from './revocation-outcome'
import {
  describeGrantError,
  describeGrantResult,
  describeRevocationResult,
} from './revocation-outcome'

interface ProfileAccessPanelProps {
  executionProfileId: string
}

/**
 * The per-profile access screen (T043, FR-179, FR-184, FR-188, FR-190).
 *
 * ## FR-190 applies to this component, not only to the router
 *
 * The profile id arrives in the URL, which means it is the caller's guess. `listForProfile` answers
 * `NOT_FOUND` for a profile that does not exist — and for one the caller may not read, with the
 * same code and the same message, so the two cannot be told apart. This panel renders that as
 * {@link NotFoundCard} and nothing else. A "you do not have permission to view this profile"
 * screen would hand back precisely the disclosure the error code was chosen to prevent: the server
 * would have been careful and the UI would have told them anyway.
 *
 * Everything else here is wiring; the shaping, the cascade text and the error mapping each live in
 * a module beside this one with its own test.
 */
export const ProfileAccessPanel = ({ executionProfileId }: ProfileAccessPanelProps) => {
  const [confirmingGrantId, setConfirmingGrantId] = useState<string | undefined>(undefined)
  const [selectedUserId, setSelectedUserId] = useState('')
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  const [error, setError] = useState<FieldErrorContent | undefined>(undefined)
  const [notice, setNotice] = useState<{ key: string; notice: GrantNotice } | undefined>(undefined)

  const utils = api.useUtils()

  // `includeRevoked` turns the access list into the access history, which is what FR-184 asks the
  // screen to show: a revoked grant is a fact about who could see this profile and when.
  const grants = api.admin.grants.listForProfile.useQuery({
    executionProfileId,
    includeRevoked: true,
    limit: 50,
  })
  const users = api.admin.users.list.useQuery({ limit: 50, activeOnly: true })

  const settle = async (key: string, settled: GrantNotice) => {
    setStartedAt(undefined)
    setConfirmingGrantId(undefined)
    setError(undefined)
    setNotice({ key, notice: settled })
    await utils.admin.grants.listForProfile.invalidate()
  }

  const refuse = (failure: unknown) => {
    setStartedAt(undefined)
    setError(describeGrantError(failure))
  }

  const grant = api.admin.grants.grant.useMutation()
  const revoke = api.admin.grants.revoke.useMutation()

  if (isNotFoundError(grants.error)) {
    return <NotFoundCard message="No such execution profile." />
  }

  const items = grants.data?.items ?? []
  const holders = liveGrantHolderIds(items)
  const candidates = (users.data?.items ?? [])
    .filter((user) => !holders.has(user.id))
    .map((user) => ({ id: user.id, displayName: user.displayName, email: user.email }))

  return (
    <div className="gap-section flex flex-col">
      <IssueGrantForm
        candidates={candidates}
        selectedUserId={selectedUserId}
        startedAt={confirmingGrantId === undefined ? startedAt : undefined}
        error={confirmingGrantId === undefined ? error : undefined}
        onSelect={(userId) => {
          setSelectedUserId(userId)
          setError(undefined)
          setNotice(undefined)
        }}
        onSubmit={() => {
          setStartedAt(Date.now())
          setNotice(undefined)
          grant.mutate(
            { userId: selectedUserId, executionProfileId },
            {
              onSuccess: (result) => {
                setSelectedUserId('')
                void settle('issue', describeGrantResult(result))
              },
              onError: refuse,
            },
          )
        }}
      />

      {notice?.key === 'issue' ? (
        <Card>
          <CardHeader>
            <span>last change</span>
            <StateChip>{notice.notice.readout}</StateChip>
          </CardHeader>
          <CardBody>
            <p className="type-body text-graphite measure-prose">{notice.notice.detail}</p>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <span>who holds access</span>
          <StateChip>
            {grants.isPending
              ? 'reading'
              : `live ${String(holders.size)} of ${String(items.length)}`}
          </StateChip>
        </CardHeader>
        <CardBody className="gap-default flex flex-col">
          <p className="type-body text-graphite measure-prose">
            Revoked grants stay listed. Revocation stamps the row rather than deleting it, so this
            list is also the access history.
          </p>

          {grants.error !== null && !isNotFoundError(grants.error) ? (
            <FieldError {...describeGrantError(grants.error)} />
          ) : null}

          {grants.isPending ? <LoadingState>reading who holds this profile</LoadingState> : null}

          {grants.isPending || grants.error !== null || items.length > 0 ? null : (
            <EmptyState>nobody has been granted this profile</EmptyState>
          )}

          <ol className="gap-close flex flex-col">
            {items.map((row) => (
              <GrantRow
                key={row.id}
                grant={row}
                confirming={confirmingGrantId === row.id}
                startedAt={confirmingGrantId === row.id ? startedAt : undefined}
                error={confirmingGrantId === row.id ? error : undefined}
                notice={notice?.key === row.id ? notice.notice : undefined}
                onSelect={() => {
                  setConfirmingGrantId(row.id)
                  setError(undefined)
                  setNotice(undefined)
                }}
                onCancel={() => {
                  setConfirmingGrantId(undefined)
                  setError(undefined)
                }}
                onConfirm={() => {
                  setStartedAt(Date.now())
                  revoke.mutate(
                    { userId: row.userId, executionProfileId },
                    {
                      onSuccess: (result) => {
                        void settle(row.id, describeRevocationResult(result))
                      },
                      onError: refuse,
                    },
                  )
                }}
              />
            ))}
          </ol>
        </CardBody>
      </Card>
    </div>
  )
}
