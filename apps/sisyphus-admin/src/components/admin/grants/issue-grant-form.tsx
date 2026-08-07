'use client'

import { ElapsedReadout } from '@sisyphus-admin/components/admin/elapsed-readout'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FieldError,
  FieldLabel,
  FOCUS_RING,
  StateChip,
} from '@sisyphus-admin/components/ui'
import { cn } from '@sisyphus-admin/lib/cn'
import { useId } from 'react'

/** A user who could be granted access. Narrower than the list row, so callers pass what they have. */
export interface GrantCandidate {
  readonly id: string
  readonly displayName: string
  readonly email: string
}

interface IssueGrantFormProps {
  candidates: readonly GrantCandidate[]
  /** The chosen user's id, or the empty string while nobody is chosen. */
  selectedUserId: string
  onSelect: (userId: string) => void
  onSubmit: () => void
  /** `Date.now()` when the grant started, or `undefined` when nothing is in flight. */
  startedAt?: number
  error?: FieldErrorContent
}

/**
 * Issuing a grant on this profile (FR-179, FR-184).
 *
 * **This is the page's one primary button.** Everything else on the access screen is a withdrawal
 * or an escape, and DESIGN.md allows exactly one primary per view — so the only thing rendered in
 * `signal` here is the action that adds access.
 *
 * The picker is a native `select` because the panel's primitive set has no combo-box and inventing
 * one here would be exactly the hand-rolled duplicate FR-033 forbids. It is styled from the same
 * tokens the field control uses so the two read as one system; the day a searchable picker is
 * needed, it belongs in `src/components/ui`, not here.
 *
 * Users who already hold a live grant are filtered out by the caller, not disabled here: the
 * server treats a second grant as a duplicate request rather than an error, so the risk is not a
 * failure — it is an admin believing they changed something when they did not.
 */
export const IssueGrantForm = ({
  candidates,
  selectedUserId,
  onSelect,
  onSubmit,
  startedAt,
  error,
}: IssueGrantFormProps) => {
  const id = useId()
  const errorId = `${id}-error`
  const pending = startedAt !== undefined

  return (
    <Card>
      <CardHeader>
        <span>issue access</span>
        <StateChip>{`candidates ${String(candidates.length)}`}</StateChip>
      </CardHeader>
      <CardBody className="gap-default flex flex-col">
        <p className="type-body text-graphite measure-prose">
          The execution profile is the unit of access. Granting it says “you may do this kind of
          work, on these repositories, with these credentials, at this cost”.
        </p>

        <div className="gap-tight flex flex-col">
          <FieldLabel htmlFor={id}>User</FieldLabel>
          <select
            id={id}
            value={selectedUserId}
            disabled={pending || candidates.length === 0}
            aria-invalid={error !== undefined}
            aria-describedby={error === undefined ? undefined : errorId}
            data-state={error === undefined ? 'valid' : 'invalid'}
            onChange={(event) => {
              onSelect(event.target.value)
            }}
            className={cn(
              'type-body bg-paper text-ink p-close rounded-sm border',
              error === undefined ? 'border-hairline-hi' : 'border-rust',
              'disabled:text-graphite disabled:border-hairline',
              FOCUS_RING,
            )}
          >
            <option value="">Choose a user</option>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {`${candidate.displayName} — ${candidate.email}`}
              </option>
            ))}
          </select>
          {error === undefined ? null : (
            <FieldError id={errorId} code={error.code} action={error.action} />
          )}
        </div>

        <div className="flex">
          {pending ? (
            <Button
              variant="primary"
              pending
              readout={<ElapsedReadout verb="Granting" startedAt={startedAt} />}
            />
          ) : (
            <Button variant="primary" disabled={selectedUserId === ''} onClick={onSubmit}>
              Grant access
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
