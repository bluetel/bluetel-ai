'use client'

import { DataReadout, ElapsedReadout } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FieldError,
  StateChip,
} from '@sisyphus-admin/components/ui'
import Link from 'next/link'

import type { CredentialReadout } from './credential-listing'

interface CredentialRowProps {
  credential: CredentialReadout
  onSetEnabled: (enabled: boolean) => void
  onDelete: () => void
  /** `Date.now()` when an action on **this** seat started, or `undefined`. */
  startedAt?: number
  error?: FieldErrorContent
}

/**
 * One seat in the pool (T034, T080, FR-009, FR-070).
 *
 * ## What the row is for
 *
 * Answering "can this seat be used, and if not what do I do about it" without a second click. So
 * three things sit above everything else: the state, the server's `selectable` verdict, and — when
 * those two disagree, which is the interesting case — the sentence saying why. A seat can be
 * `available`, enabled, logged in, and still handed to nobody because the group it sits in was
 * withdrawn; a row that showed only the state would report that seat as fine.
 *
 * `lastFailureReason` is rendered **verbatim** and in full (FR-009). It carries the provider's own
 * words about why a login broke, or the platform's about why a login environment could not be
 * started or was reaped, and it is very often the only evidence an administrator has. Truncating or
 * rewording it here would put the panel between them and it.
 *
 * ## There is no field on this row, and there never will be
 *
 * Until Phase 7 there was one: the name of a secret an operator had written by hand with the AWS
 * CLI. It took an identifier and never material, which satisfied FR-070 — and it also meant a seat
 * could reach `available` without a login ever having happened, which FR-008 is about. Both the
 * field and the procedure behind it are gone.
 *
 * What replaces it is a **link**, not a control. Logging a seat in is a session with an environment
 * at the other end of it, so it has its own page (`./[id]/login`) where a terminal can be drawn and
 * a deadline counted down. A button here would have had to start an EC2 instance from a row in a
 * list, and then had nowhere to put what came back.
 */
export const CredentialRow = ({
  credential,
  onSetEnabled,
  onDelete,
  startedAt,
  error,
}: CredentialRowProps) => {
  const pending = startedAt !== undefined
  // The two states a login is the remedy for: one that has never worked, and one that has stopped.
  // The same pair the router refuses out of, so the panel does not offer what the server declines.
  const acceptsLogin = credential.state === 'awaiting_login' || credential.state === 'unhealthy'

  return (
    <Card>
      <CardHeader>
        {/*
          The seat's name is the way to its own page (`./[id]`), where recovering it is a sequence
          rather than three buttons — disable, force-release, log in again — and where FR-005's
          delete refusal has room to be read. The row keeps the controls it always had; what it
          cannot do in one line is say which order to press them in.
        */}
        <Link className="underline underline-offset-4" href={`/admin/credentials/${credential.id}`}>
          {credential.name}
        </Link>
        <StateChip>{credential.state}</StateChip>
      </CardHeader>
      <CardBody className="gap-default flex flex-col">
        <div className="gap-default flex flex-wrap">
          <DataReadout label="group" value={credential.credentialGroupName} />
          <DataReadout label="usable" value={credential.selectable ? 'yes' : 'no'} />
          <DataReadout label="last login" value={credential.lastLogin} />
          <DataReadout label="last used" value={credential.lastUsed} />
          <DataReadout label="secret" value={credential.secretId ?? 'none recorded'} />
        </div>

        {credential.withheldBecause === undefined ? null : (
          <p className="type-body text-graphite measure-prose">
            {`Withheld from selection: ${credential.withheldBecause}.`}
          </p>
        )}

        {credential.lastFailureReason === undefined ? null : (
          <p className="type-data-mono text-rust measure-prose">{credential.lastFailureReason}</p>
        )}

        {error === undefined ? null : <FieldError code={error.code} action={error.action} />}

        <div className="gap-tight flex flex-wrap items-center">
          {pending ? (
            <Button
              variant="secondary"
              pending
              readout={<ElapsedReadout verb="Working" startedAt={startedAt} />}
            />
          ) : (
            <>
              {acceptsLogin && !credential.archived ? (
                <Link
                  className="type-body text-ink underline underline-offset-4"
                  href={`/admin/credentials/${credential.id}/login`}
                >
                  {credential.state === 'awaiting_login' ? 'Log in' : 'Log in again'}
                </Link>
              ) : null}

              {credential.archived ? null : (
                <Button
                  variant="secondary"
                  onClick={() => {
                    onSetEnabled(!credential.enabled)
                  }}
                >
                  {credential.enabled ? 'Disable' : 'Enable'}
                </Button>
              )}

              {credential.archived ? null : (
                <Button variant="secondary" onClick={onDelete}>
                  Delete
                </Button>
              )}
            </>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
