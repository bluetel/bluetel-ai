'use client'

import { DataReadout, describeTrpcError, ElapsedReadout } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FieldError,
  LoadingState,
  StateChip,
} from '@sisyphus-admin/components/ui'
import { api } from '@sisyphus-admin/trpc'
import Link from 'next/link'
import { useState } from 'react'

import { FORCE_RELEASE_WARNING, recoveryAffordancesFor } from './recovery-actions'

interface CredentialRecoveryPanelProps {
  readonly agentCredentialId: string
}

/**
 * `/admin/credentials/{id}` — recovering one seat (T121, FR-005, FR-006, FR-010, FR-057, FR-072,
 * SC-012).
 *
 * ## Why the seat has a page of its own
 *
 * The pool list answers "which seat is broken". This answers "what do I do about it", and the two
 * are different screens because recovering a seat is a **sequence** rather than a control: disable
 * it, take it back from the run holding it, log it in again. A row in a list can offer three
 * buttons; it cannot say which one to press first, and pressing them in the wrong order is how a
 * five-minute recovery (SC-012) becomes a puzzle. The order lives in `recovery-actions.ts`, pure
 * and tested, and this renders it.
 *
 * ## Force-release is the one control here that costs somebody something
 *
 * It ends the run holding the seat, because FR-023 forbids moving a workflow to a different agent
 * credential under any circumstance — so there is nothing for that run to continue on. The panel
 * therefore states the cost **before** the button rather than behind a confirmation dialog: a
 * dialog is dismissed by muscle memory, and the sentence that matters is not "are you sure" but
 * "this ends a run that is currently working".
 *
 * ## Deleting is offered and usually refused, and the refusal is the feature
 *
 * FR-005 refuses to delete a credential any workflow has ever held, because `credential_leases` and
 * `workflows.agent_credential_id` are how a finished run answers what identity it worked as. The
 * refusal names how many times the seat was leased and offers disabling instead, and it is rendered
 * **verbatim**. Predicting it here — hiding the button when this panel guessed the seat had history
 * — would be a second implementation of FR-005, and the one an administrator sees would be the one
 * that is wrong.
 *
 * ## Logging in is a link and not a button
 *
 * Same reason it is a link in the pool list: a login is a session with an EC2 instance at the other
 * end of it, and it needs somewhere to draw a terminal and count down a deadline. `./login` is that
 * page, and it is the identical page a seat that has never worked goes through (FR-072).
 */

/** How often the seat is re-read while an administrator works on it. */
const POLL_INTERVAL_MS = 5_000

export const CredentialRecoveryPanel = ({ agentCredentialId }: CredentialRecoveryPanelProps) => {
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  const [error, setError] = useState<FieldErrorContent | undefined>(undefined)

  const utils = api.useUtils()
  const seat = api.admin.credentials.get.useQuery(
    { agentCredentialId },
    { refetchInterval: POLL_INTERVAL_MS },
  )

  const setEnabled = api.admin.credentials.setEnabled.useMutation()
  const forceRelease = api.admin.credentials.forceRelease.useMutation()
  const remove = api.admin.credentials.delete.useMutation()

  const credential = seat.data
  const affordances = credential === undefined ? undefined : recoveryAffordancesFor(credential)

  const settle = () => {
    setStartedAt(undefined)
    setError(undefined)
    void utils.admin.credentials.get.invalidate()
    void utils.admin.credentials.list.invalidate()
  }

  const refuse = (failure: unknown) => {
    setStartedAt(undefined)
    // Rendered as the server worded it. FR-005's refusal names the lease count and the way forward,
    // and a panel that summarised it would drop the half an administrator needs.
    setError(describeTrpcError(failure))
  }

  const act = (run: () => void) => {
    setStartedAt(Date.now())
    setError(undefined)
    run()
  }

  return (
    <div className="gap-section flex flex-col">
      <Card>
        <CardHeader>
          <span>{credential?.name ?? 'agent credential'}</span>
          <StateChip>{credential?.state ?? 'reading'}</StateChip>
        </CardHeader>
        <CardBody className="gap-default flex flex-col">
          {seat.isPending ? <LoadingState>reading the seat</LoadingState> : null}

          {seat.error === null ? null : <FieldError {...describeTrpcError(seat.error)} />}

          {credential === undefined ? null : (
            <div className="gap-default flex flex-wrap">
              <DataReadout label="group" value={credential.credentialGroupName} />
              <DataReadout label="usable" value={credential.selectable ? 'yes' : 'no'} />
              <DataReadout label="enabled" value={credential.enabled ? 'yes' : 'no'} />
              <DataReadout label="secret" value={credential.secretId ?? 'none recorded'} />
            </div>
          )}

          {/* Verbatim (FR-009). Very often the only evidence of what actually broke. */}
          {credential?.lastFailureReason === null ||
          credential?.lastFailureReason === undefined ? null : (
            <p className="type-data-mono text-rust measure-prose">{credential.lastFailureReason}</p>
          )}

          {affordances?.nextStep === undefined ? null : (
            <p className="type-body text-ink measure-prose">{affordances.nextStep}</p>
          )}

          {error === undefined ? null : <FieldError code={error.code} action={error.action} />}
        </CardBody>
      </Card>

      {affordances?.canForceRelease !== true ? null : (
        <Card>
          <CardHeader>
            <span>the run holding this seat</span>
            <StateChip>held</StateChip>
          </CardHeader>
          <CardBody className="gap-default flex flex-col">
            <p className="type-body text-rust measure-prose">{FORCE_RELEASE_WARNING}</p>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody className="gap-tight flex flex-wrap items-center">
          {startedAt !== undefined ? (
            <Button
              variant="secondary"
              pending
              readout={<ElapsedReadout verb="Working" startedAt={startedAt} />}
            />
          ) : (
            <>
              {affordances?.canLogIn === true ? (
                <Link
                  className="type-body text-ink underline underline-offset-4"
                  href={`/admin/credentials/${agentCredentialId}/login`}
                >
                  {credential?.state === 'awaiting_login' ? 'Log in' : 'Log in again'}
                </Link>
              ) : null}

              {affordances?.canDisable === true || affordances?.canEnable === true ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    act(() => {
                      setEnabled.mutate(
                        { agentCredentialId, enabled: affordances.canEnable },
                        { onSuccess: settle, onError: refuse },
                      )
                    })
                  }}
                >
                  {affordances.canEnable ? 'Enable' : 'Disable'}
                </Button>
              ) : null}

              {affordances?.canForceRelease === true ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    act(() => {
                      forceRelease.mutate(
                        { agentCredentialId },
                        { onSuccess: settle, onError: refuse },
                      )
                    })
                  }}
                >
                  Force-release
                </Button>
              ) : null}

              {affordances?.canAttemptDelete === true ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    act(() => {
                      remove.mutate({ agentCredentialId }, { onSuccess: settle, onError: refuse })
                    })
                  }}
                >
                  Delete
                </Button>
              ) : null}
            </>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
