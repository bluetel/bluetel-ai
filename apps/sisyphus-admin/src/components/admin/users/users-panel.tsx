'use client'

import { describeTrpcError } from '@sisyphus-admin/components/admin/trpc-error'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  LoadingState,
  StateChip,
} from '@sisyphus-admin/components/ui'
import { api } from '@sisyphus-admin/trpc'
import { useState } from 'react'

import { RoleChangeHistory } from './role-change-history'
import type { UserActionKind } from './user-actions'
import { UserCard } from './user-card'
import type { UserChangeNotice } from './user-change-outcome'
import { describeUserChange, describeUserChangeError } from './user-change-outcome'

/**
 * The user-management screen (T039, FR-171..FR-173, FR-175..FR-177).
 *
 * This module is wiring: it holds the two queries, the two mutations and the small amount of state
 * that says which row is mid-change. Everything that can be *wrong* — how a row reads, which
 * changes a row allows, what a refusal means, what a deactivation left behind — lives in the
 * modules beside it with its own test, so nothing important is asserted only by looking at the
 * screen.
 *
 * ## Why one selection rather than one per row
 *
 * A single `selection` means confirming a change on one user closes any confirmation open on
 * another. Two half-filled reason fields on two rows is a state where the operator can very easily
 * confirm the one they were not reading.
 *
 * ## Why the list is invalidated rather than patched
 *
 * `setRole` and `setActive` both return the updated row, and writing it into the cache by hand
 * would be faster and wrong: the counts on *other* rows move too — `activeAdminCount` is not shown
 * but the reassignment backlog is — and a hand-patched list is the one that quietly disagrees with
 * the database. The invalidation costs one query on a screen used a few times a week.
 */

interface Selection {
  readonly userId: string
  readonly kind: UserActionKind
  readonly reason: string
  /** `Date.now()` when the mutation started, or `undefined` while the operator is still deciding. */
  readonly startedAt?: number
}

interface Outcome {
  readonly userId: string
  readonly notice?: UserChangeNotice
  readonly error?: FieldErrorContent
}

export const UsersPanel = () => {
  const [search, setSearch] = useState('')
  const [selection, setSelection] = useState<Selection | undefined>(undefined)
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined)

  const utils = api.useUtils()

  const users = api.admin.users.list.useQuery({
    limit: 50,
    activeOnly: false,
    search: search.trim() === '' ? undefined : search.trim(),
  })
  const history = api.admin.users.roleChanges.useQuery({ limit: 50 })

  const settled = async (userId: string, notice: UserChangeNotice) => {
    setSelection(undefined)
    setOutcome({ userId, notice })
    await Promise.all([
      utils.admin.users.list.invalidate(),
      utils.admin.users.roleChanges.invalidate(),
    ])
  }

  const refused = (userId: string, error: unknown) => {
    setSelection((current) =>
      current === undefined ? current : { ...current, startedAt: undefined },
    )
    setOutcome({ userId, error: describeUserChangeError(error) })
  }

  const setRole = api.admin.users.setRole.useMutation()
  const setActive = api.admin.users.setActive.useMutation()

  /**
   * `startedAt` is read at the click rather than taken here. `Date.now()` is impure, and a
   * component body — which this closure is part of — may be re-run by React at any time; the clock
   * belongs to the event, which happens exactly once.
   */
  const confirm = (
    userId: string,
    kind: UserActionKind,
    reason: string,
    startedAt: number,
  ): void => {
    setSelection({ userId, kind, reason, startedAt })
    setOutcome(undefined)

    const trimmed = reason.trim() === '' ? undefined : reason.trim()
    const onSuccess = (result: Parameters<typeof describeUserChange>[1]) =>
      void settled(userId, describeUserChange(kind, result))
    const onError = (error: unknown) => {
      refused(userId, error)
    }

    if (kind === 'grant-admin' || kind === 'revoke-admin') {
      setRole.mutate(
        { userId, role: kind === 'grant-admin' ? 'admin' : 'engineer', reason: trimmed },
        { onSuccess, onError },
      )
      return
    }

    setActive.mutate(
      { userId, isActive: kind === 'reactivate', reason: trimmed },
      { onSuccess, onError },
    )
  }

  const items = users.data?.items ?? []

  return (
    <div className="gap-section flex flex-col">
      <Card>
        <CardHeader>
          <span>users</span>
          <StateChip>{users.isPending ? 'reading' : `listed ${String(items.length)}`}</StateChip>
        </CardHeader>
        <CardBody className="gap-default flex flex-col">
          <Field
            label="Search by name or address"
            name="search"
            value={search}
            error={users.error === null ? undefined : describeTrpcError(users.error)}
            onChange={(event) => {
              setSearch(event.target.value)
            }}
          />
          {users.isPending ? <LoadingState>reading the user list</LoadingState> : null}

          {users.isPending || users.error !== null || items.length > 0 ? null : (
            <EmptyState>no users match that search</EmptyState>
          )}
        </CardBody>
      </Card>

      {items.map((user) => (
        <UserCard
          key={user.id}
          user={user}
          selected={selection?.userId === user.id ? selection.kind : undefined}
          reason={selection?.userId === user.id ? selection.reason : ''}
          startedAt={selection?.userId === user.id ? selection.startedAt : undefined}
          error={outcome?.userId === user.id ? outcome.error : undefined}
          notice={outcome?.userId === user.id ? outcome.notice : undefined}
          onSelect={(kind) => {
            setOutcome(undefined)
            setSelection({ userId: user.id, kind, reason: '' })
          }}
          onCancel={() => {
            setSelection(undefined)
          }}
          onReasonChange={(reason) => {
            setSelection((current) => (current === undefined ? current : { ...current, reason }))
          }}
          onConfirm={(kind) => {
            confirm(user.id, kind, selection?.reason ?? '', Date.now())
          }}
        />
      ))}

      <RoleChangeHistory
        entries={history.data?.items ?? []}
        loading={history.isPending}
        error={history.error === null ? undefined : describeTrpcError(history.error)}
      />
    </div>
  )
}
