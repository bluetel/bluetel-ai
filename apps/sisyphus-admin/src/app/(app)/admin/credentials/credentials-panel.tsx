'use client'

import { describeTrpcError } from '@sisyphus-admin/components/admin'
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

import { toCredentialReadout } from './credential-listing'
import { CredentialRow } from './credential-row'
import { RegisterCredentialForm } from './register-credential-form'

/**
 * `/admin/credentials` — the pool (T034, FR-004..FR-009, FR-061).
 *
 * Wiring and nothing else: two queries, three mutations, and the state saying which seat an action
 * is in flight for. Everything that can be *wrong* — what a seat's row says about why it is not
 * usable, how the register form is shaped, how a refusal reads — lives in a module beside this one
 * with its own test.
 *
 * ## `includeArchived` is on
 *
 * FR-005 archives rather than deletes, precisely so a finished run can still say what identity it
 * worked as. Hiding archived seats would make that record unreachable from the surface that owns
 * it. They are shown, marked deleted, and refused for editing by the router rather than by a guess
 * made here.
 *
 * ## Logging a seat in is not one of the mutations, and that is deliberate
 *
 * The list links to `./[id]/login` and starts nothing itself. A login is a session with an EC2
 * instance at the other end of it: it needs somewhere to draw a terminal, somewhere to count down
 * the deadline the environment was given, and somewhere to poll while the platform captures what
 * the agent produced. A button in a list row would have started all of that and had nowhere to put
 * what came back.
 *
 * ## Why every mutation invalidates rather than patching the cache
 *
 * All three change something the *list* computes. `register` adds a row; `setEnabled` flips the
 * server's `selectable` verdict without touching the state; `delete` archives. The verdict in
 * particular is computed in the database from the same predicate an allocator filters on — writing
 * it here by hand would be faster and would be the version that quietly disagrees with the
 * allocator, which is the one disagreement this feature cannot afford.
 */

/** Which seat an action is running against, so one row's spinner is not every row's. */
interface Busy {
  readonly id: string
  readonly startedAt: number
}

export const CredentialsPanel = () => {
  const [name, setName] = useState('')
  const [credentialGroupId, setCredentialGroupId] = useState('')
  const [busy, setBusy] = useState<Busy | undefined>(undefined)
  const [registering, setRegistering] = useState<number | undefined>(undefined)
  const [error, setError] = useState<FieldErrorContent | undefined>(undefined)

  const utils = api.useUtils()
  const credentials = api.admin.credentials.list.useQuery({ includeArchived: true, limit: 100 })
  const groups = api.admin.credentialGroups.list.useQuery({ limit: 100 })

  const register = api.admin.credentials.register.useMutation()
  const setEnabled = api.admin.credentials.setEnabled.useMutation()
  const remove = api.admin.credentials.delete.useMutation()

  const items = (credentials.data?.items ?? []).map(toCredentialReadout)
  const groupOptions = (groups.data?.items ?? []).map((group) => ({
    id: group.id,
    name: group.name,
    enabled: group.enabled,
  }))

  const settle = async () => {
    setBusy(undefined)
    setRegistering(undefined)
    setError(undefined)
    await utils.admin.credentials.list.invalidate()
  }

  const refuse = (failure: unknown) => {
    setBusy(undefined)
    setRegistering(undefined)
    setError(describeTrpcError(failure))
  }

  /**
   * Mark one seat busy and run its mutation.
   *
   * `startedAt` is passed in rather than read here: `Date.now()` is impure, and the only place the
   * React rules allow it is inside the event handler itself — which is also the only place it is
   * meaningfully "now", since a helper called during render would capture the render's clock.
   */
  const act = (id: string, startedAt: number, run: () => void) => {
    setBusy({ id, startedAt })
    setError(undefined)
    run()
  }

  return (
    <div className="gap-section flex flex-col">
      <Card>
        <CardHeader>
          <span>agent credentials</span>
          <StateChip>
            {credentials.isPending ? 'reading' : `loaded ${String(items.length)}`}
          </StateChip>
        </CardHeader>
        <CardBody className="gap-default flex flex-col">
          <p className="type-body text-graphite measure-prose">
            One seat is one agent identity, held by at most one run at a time. A seat is usable only
            once a login has been completed inside the platform&rsquo;s own infrastructure; until
            then it is registered, visible, and handed to nobody.
          </p>

          {credentials.error === null ? null : (
            <FieldError {...describeTrpcError(credentials.error)} />
          )}

          {credentials.isPending ? <LoadingState>reading the pool</LoadingState> : null}

          {credentials.isPending || credentials.error !== null || items.length > 0 ? null : (
            <EmptyState>no agent credentials have been registered</EmptyState>
          )}
        </CardBody>
      </Card>

      <RegisterCredentialForm
        groups={groupOptions}
        name={name}
        credentialGroupId={credentialGroupId}
        startedAt={registering}
        error={busy === undefined && registering !== undefined ? error : undefined}
        onNameChange={setName}
        onGroupChange={setCredentialGroupId}
        onSubmit={() => {
          setRegistering(Date.now())
          setError(undefined)
          register.mutate(
            { name: name.trim(), credentialGroupId },
            {
              onSuccess: () => {
                setName('')
                void settle()
              },
              onError: refuse,
            },
          )
        }}
      />

      {items.map((credential) => (
        <CredentialRow
          key={credential.id}
          credential={credential}
          startedAt={busy?.id === credential.id ? busy.startedAt : undefined}
          error={busy?.id === credential.id ? error : undefined}
          onSetEnabled={(enabled) => {
            act(credential.id, Date.now(), () => {
              setEnabled.mutate(
                { agentCredentialId: credential.id, enabled },
                {
                  onSuccess: () => {
                    void settle()
                  },
                  onError: refuse,
                },
              )
            })
          }}
          onDelete={() => {
            act(credential.id, Date.now(), () => {
              remove.mutate(
                { agentCredentialId: credential.id },
                {
                  onSuccess: () => {
                    void settle()
                  },
                  onError: refuse,
                },
              )
            })
          }}
        />
      ))}
    </div>
  )
}
