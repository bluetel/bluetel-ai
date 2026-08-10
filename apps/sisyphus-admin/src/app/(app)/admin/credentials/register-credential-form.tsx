'use client'

import { ElapsedReadout } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  FieldError,
  FieldLabel,
  FOCUS_RING,
  StateChip,
} from '@sisyphus-admin/components/ui'
import { cn } from '@sisyphus-admin/lib/cn'
import { useId } from 'react'

/** A group a seat can be registered into. Narrower than the list row, so callers pass what they have. */
export interface CredentialGroupOption {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
}

interface RegisterCredentialFormProps {
  groups: readonly CredentialGroupOption[]
  name: string
  /** The chosen group's id, or the empty string while none is chosen. */
  credentialGroupId: string
  onNameChange: (name: string) => void
  onGroupChange: (credentialGroupId: string) => void
  onSubmit: () => void
  /** `Date.now()` when the registration started, or `undefined` when nothing is in flight. */
  startedAt?: number
  error?: FieldErrorContent
}

/**
 * Registering a seat into a group (T034, FR-061, FR-008).
 *
 * **The form has two fields and there is not a third.** A name and a group is the whole of a
 * registration: the seat is created in `awaiting_login` with no secret, and it becomes usable only
 * once material exists in the secret store and its identifier has been recorded. A field for that
 * identifier deliberately does not live here — it lives on the seat's own row, because the two are
 * separate acts minutes or hours apart, and a form that asked for both at once would imply an
 * administrator should have the secret in front of them while registering. They should not: the
 * material is written where it already is, by an operator, and never passes through this browser
 * (FR-070).
 *
 * The group picker is a native `select` for the reason `IssueGrantForm`'s is — the panel's
 * primitive set has no combo-box, and inventing one here is exactly the hand-rolled duplicate
 * FR-033 forbids.
 *
 * A **disabled** group is offered, and marked as disabled. Disabling withdraws a pool's capacity
 * rather than closing it to administration, and staging replacement seats inside a withdrawn pool
 * is the ordinary way to rebuild one — so the picker states the fact and lets the administrator
 * decide, rather than hiding the group and leaving them to wonder where it went.
 */
export const RegisterCredentialForm = ({
  groups,
  name,
  credentialGroupId,
  onNameChange,
  onGroupChange,
  onSubmit,
  startedAt,
  error,
}: RegisterCredentialFormProps) => {
  const id = useId()
  const errorId = `${id}-error`
  const pending = startedAt !== undefined

  return (
    <Card>
      <CardHeader>
        <span>register a seat</span>
        <StateChip>{`groups ${String(groups.length)}`}</StateChip>
      </CardHeader>
      <CardBody className="gap-default flex flex-col">
        <p className="type-body text-graphite measure-prose">
          A seat is one agent identity the platform can work as, and it belongs to exactly one
          group. It is registered awaiting a login and is handed to nobody until material exists for
          it in the secret store.
        </p>

        <Field
          label="Name"
          value={name}
          disabled={pending}
          placeholder="seat-one"
          onChange={(event) => {
            onNameChange(event.target.value)
          }}
        />

        <div className="gap-tight flex flex-col">
          <FieldLabel htmlFor={id}>Credential group</FieldLabel>
          <select
            id={id}
            value={credentialGroupId}
            disabled={pending || groups.length === 0}
            aria-invalid={error !== undefined}
            aria-describedby={error === undefined ? undefined : errorId}
            data-state={error === undefined ? 'valid' : 'invalid'}
            onChange={(event) => {
              onGroupChange(event.target.value)
            }}
            className={cn(
              'type-body bg-paper text-ink p-close rounded-sm border',
              error === undefined ? 'border-hairline-hi' : 'border-rust',
              'disabled:text-graphite disabled:border-hairline',
              FOCUS_RING,
            )}
          >
            <option value="">Choose a group</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.enabled ? group.name : `${group.name} — disabled`}
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
              readout={<ElapsedReadout verb="Registering" startedAt={startedAt} />}
            />
          ) : (
            <Button
              variant="primary"
              disabled={name.trim() === '' || credentialGroupId === ''}
              onClick={onSubmit}
            >
              Register seat
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
