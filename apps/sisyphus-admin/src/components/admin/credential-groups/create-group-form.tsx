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
} from '@sisyphus-admin/components/ui'

import type { CredentialGroupNotice } from './group-outcome'

/**
 * Creating a credential group (T026, FR-060, FR-061).
 *
 * The prose says what a group *is for* rather than what the field does, because the consequence of
 * naming one is not obvious from a name box: a credential is assigned to exactly one group **at
 * registration** (FR-061) and a run may only ever be given a credential from a group its execution
 * profile is attached to (FR-063). So the groups an administrator creates here are the shape every
 * later capacity decision is made in, and getting that shape wrong is expensive to undo — a
 * credential moves between groups, but the profiles pointing at the old one do not follow it.
 */

interface CreateGroupFormProps {
  name: string
  description: string
  onChange: (patch: { name?: string; description?: string }) => void
  onSubmit: () => void
  /** `Date.now()` when the change was submitted, or `undefined` when nothing is in flight. */
  startedAt?: number
  error?: FieldErrorContent
  notice?: CredentialGroupNotice
}

export const CreateGroupForm = ({
  name,
  description,
  onChange,
  onSubmit,
  startedAt,
  error,
  notice,
}: CreateGroupFormProps) => {
  const pending = startedAt !== undefined

  return (
    <Card>
      <CardHeader>
        <span>new credential group</span>
      </CardHeader>
      <CardBody className="gap-default flex flex-col">
        <p className="type-body text-graphite measure-prose">
          A group is a pool of agent identities. Every credential belongs to exactly one, chosen
          when it is registered, and a run is only ever given a credential from a group its
          execution profile is attached to — so these are the units capacity is reserved and
          reasoned about in. A new group arrives enabled and empty, which hands nothing to anybody
          until a credential is filed under it.
        </p>

        <Field
          label="Name"
          value={name}
          placeholder="Payments"
          disabled={pending}
          onChange={(event) => {
            onChange({ name: event.target.value })
          }}
        />

        <Field
          label="Description"
          value={description}
          placeholder="optional — what this pool is for"
          disabled={pending}
          onChange={(event) => {
            onChange({ description: event.target.value })
          }}
        />

        {error === undefined ? null : <FieldError code={error.code} action={error.action} />}

        <div className="flex">
          {pending ? (
            <Button
              variant="primary"
              pending
              readout={<ElapsedReadout verb="Creating" startedAt={startedAt} />}
            />
          ) : (
            <Button variant="primary" disabled={name.trim() === ''} onClick={onSubmit}>
              Create credential group
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
