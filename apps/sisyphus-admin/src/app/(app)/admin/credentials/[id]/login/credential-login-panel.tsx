'use client'

import { describeTrpcError, ElapsedReadout } from '@sisyphus-admin/components/admin'
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
import { useState } from 'react'

interface CredentialLoginPanelProps {
  readonly agentCredentialId: string
}

/**
 * `/admin/credentials/{id}/login` — the relayed login (T080, FR-069..FR-072, SC-001).
 *
 * ## What this page does, and the one thing it deliberately cannot do
 *
 * It starts an environment, shows the administrator the session handle for the terminal into it,
 * counts down the deadline that environment was launched with, and polls until the seat turns
 * `available`.
 *
 * **It never sees the credential.** The agent's login runs inside the environment; the material the
 * login produces is written to a file on that instance and read from there by the control plane,
 * which puts it straight into the secret store (FR-070). There is no field on this page, no
 * download, nothing to copy, and — the part that matters — no response it could arrive in: the
 * administrative surface's port onto this machinery has no method that returns a value, so a future
 * change wanting to show material here would have to widen the port first, in the package where
 * that rule is written down.
 *
 * ## Why there is no "I'm done" button
 *
 * The platform is not told the login worked. It watches the instance for the material and it
 * watches the clock for the deadline, and the page polls `loginStatus` until one of the two
 * resolves. A completion button would make putting a seat into service depend on a report — and the
 * case that matters most, the administrator who closes this tab (FR-071), is exactly the case where
 * no report is ever sent. Building the happy path on a signal the failure path cannot produce is
 * how the failure path ends up untested.
 *
 * So closing this tab is a supported way to abandon a login, not an accident to be guarded against.
 * The environment is destroyed by a wall-clock reaper whether or not anybody comes back, and the
 * reason lands on the seat where the pool view shows it.
 *
 * ## The polling interval, and why it is not adaptive
 *
 * Three seconds, fixed. A login is a handful of minutes with a person in the middle of it, so the
 * cost of polling is negligible and the value of seeing the seat flip promptly is high. Backing off
 * would save nothing measurable and would make the one moment that matters — the capture landing —
 * the slowest thing on the page.
 */

/** How often the seat is re-read while a login is in flight. See the module note. */
const POLL_INTERVAL_MS = 3_000

export const CredentialLoginPanel = ({ agentCredentialId }: CredentialLoginPanelProps) => {
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  const [error, setError] = useState<FieldErrorContent | undefined>(undefined)
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)

  const utils = api.useUtils()
  const status = api.admin.credentials.loginStatus.useQuery(
    { agentCredentialId },
    { refetchInterval: POLL_INTERVAL_MS },
  )
  const startLogin = api.admin.credentials.startLogin.useMutation()

  const credential = status.data?.credential
  const environment = status.data?.environment
  const expired = status.data?.expired === true

  // The two states a login is the remedy for. Read from the server's answer rather than from what
  // this page did, so a seat somebody else logged in while this tab was open stops offering one.
  const acceptsLogin = credential?.state === 'awaiting_login' || credential?.state === 'unhealthy'

  return (
    <div className="gap-section flex flex-col">
      <Card>
        <CardHeader>
          <span>{credential?.name ?? 'agent credential'}</span>
          <StateChip>{credential?.state ?? 'reading'}</StateChip>
        </CardHeader>
        <CardBody className="gap-default flex flex-col">
          <p className="type-body text-graphite measure-prose">
            The login runs on an instance the platform provisions for it — no workspace, no setup
            bundle, nothing but the agent. You drive the agent&rsquo;s own login over a relayed
            terminal; what the login produces is written on that instance and captured into the
            secret store by the platform. It is never sent to this page, and there is nothing here
            to copy or download.
          </p>

          {status.isPending ? <LoadingState>reading the seat</LoadingState> : null}

          {status.error === null ? null : <FieldError {...describeTrpcError(status.error)} />}

          {credential?.lastFailureReason === null ||
          credential?.lastFailureReason === undefined ? null : (
            // Verbatim (FR-009). Very often the only evidence of why the last attempt did not work.
            <p className="type-data-mono text-rust measure-prose">{credential.lastFailureReason}</p>
          )}

          {error === undefined ? null : <FieldError code={error.code} action={error.action} />}
        </CardBody>
      </Card>

      {environment === undefined ? null : (
        <Card>
          <CardHeader>
            <span>login environment</span>
            <StateChip>{expired ? 'past its limit' : 'running'}</StateChip>
          </CardHeader>
          <CardBody className="gap-default flex flex-col">
            <p className="type-data-mono text-graphite">{environment.environmentId}</p>
            <p className="type-body text-graphite measure-prose">
              {expired
                ? 'This environment has run past its time limit and is being destroyed. Nothing has been recorded against the credential — start the login again.'
                : 'Attach a Session Manager terminal to the instance above and complete the agent’s login inside it. This environment is destroyed when the login is captured, and destroyed anyway once its time limit passes — closing this tab is a safe way to abandon the attempt.'}
            </p>
            <p className="type-body text-graphite">
              <ElapsedReadout verb="Running" startedAt={environment.startedAt.getTime()} />
            </p>
            {sessionId === undefined ? null : (
              <p className="type-data-mono text-graphite">{`session ${sessionId}`}</p>
            )}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody className="gap-tight flex flex-wrap">
          {startedAt !== undefined ? (
            <Button
              variant="secondary"
              pending
              readout={<ElapsedReadout verb="Provisioning" startedAt={startedAt} />}
            />
          ) : (
            <Button
              variant="primary"
              disabled={!acceptsLogin || (environment !== undefined && !expired)}
              onClick={() => {
                setStartedAt(Date.now())
                setError(undefined)
                startLogin.mutate(
                  { agentCredentialId },
                  {
                    onSuccess: (started) => {
                      setStartedAt(undefined)
                      // The session handle is what a terminal attaches with. It is a credential for
                      // one session on one instance, issued by AWS to the platform's role — not the
                      // agent credential, which never reaches this page at all.
                      setSessionId(started.relay.sessionId)
                      void utils.admin.credentials.loginStatus.invalidate()
                      void utils.admin.credentials.list.invalidate()
                    },
                    onError: (failure) => {
                      setStartedAt(undefined)
                      setSessionId(undefined)
                      setError(describeTrpcError(failure))
                    },
                  },
                )
              }}
            >
              {credential?.state === 'unhealthy' ? 'Start re-login' : 'Start login'}
            </Button>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
