'use client'

import { DataReadout } from '@sisyphus-admin/components/admin/data-readout'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FieldError,
  StateChip,
} from '@sisyphus-admin/components/ui'

import type { IntegrationReadouts } from './integration-listing'
import type { ValidationView } from './integrations-client'

interface IntegrationCardProps {
  integration: IntegrationReadouts
  onEdit: () => void
  onSetEnabled: (enabled: boolean) => void
  onValidate: () => void
  onRunNow: () => void
  validation?: ValidationView
  /** `Date.now()` while an action on this card is in flight. */
  startedAt?: number
  error?: FieldErrorContent
}

/**
 * One board, as an admin reads it (T121, FR-097, FR-105, FR-106, FR-155).
 *
 * ## What it leads with
 *
 * The schedule and the next fire times, in the integration's own timezone. An integration is a
 * thing that spends money unattended; the first question about one is when it next does that, and
 * the second is what it did last time. The board URL and the mappings come after, because they are
 * what you check once and the schedule is what you check every time.
 *
 * ## Auto-disabled is its own state
 *
 * Not a `disabled` chip with an explanation buried below. An integration the platform switched off
 * after repeated failures (FR-106) has a fault a human has to fix, and an integration an admin
 * switched off has not — rendering both as "disabled" hides the difference at exactly the moment it
 * matters.
 *
 * ## Run now is secondary, and absent when it would do nothing
 *
 * `runNow` asks the control plane to tick (FR-035); the server refuses it for a disabled
 * integration, so the button is not offered for one. A control that exists only to produce a
 * refusal is a control that teaches an operator to ignore refusals.
 */
export const IntegrationCard = ({
  integration,
  onEdit,
  onSetEnabled,
  onValidate,
  onRunNow,
  validation,
  startedAt,
  error,
}: IntegrationCardProps) => {
  const pending = startedAt !== undefined

  return (
    <Card>
      <CardHeader>
        <span>{integration.name}</span>
        <StateChip>{integration.state}</StateChip>
      </CardHeader>
      <CardBody className="gap-default flex flex-col">
        <div className="gap-default grid grid-cols-1 sm:grid-cols-2">
          <DataReadout label="schedule" value={integration.schedule} />
          <DataReadout label="timezone" value={integration.timezone} />
          <DataReadout label="expression" value={integration.scheduleExpression} />
          <DataReadout
            label="schedule registered"
            value={integration.scheduleRegistered ? 'yes' : 'not yet'}
          />
        </div>

        <div className="gap-hair flex flex-col">
          <span className="type-label-mono text-graphite">
            {`next runs — ${integration.timezone}`}
          </span>
          {integration.nextRuns.length === 0 ? (
            <span className="type-data-mono text-rust">
              this expression could not be read, so no fire times can be shown
            </span>
          ) : (
            <ul className="gap-hair flex flex-col">
              {integration.nextRuns.map((run) => (
                <li key={run} className="type-data-mono text-ink">
                  {run}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="gap-default grid grid-cols-1 sm:grid-cols-2">
          <DataReadout label="board" value={integration.board} />
          <DataReadout label="mappings" value={integration.mappingSummary} />
          <DataReadout label="ceilings" value={integration.ceilings} />
          <DataReadout label="last tick" value={integration.lastRun} />
          <DataReadout label="tickets claimed" value={integration.claimedTicketCount} />
          <DataReadout label="workflows started" value={integration.startedWorkflowCount} />
          <DataReadout label="consecutive failures" value={integration.consecutiveFailures} />
        </div>

        {integration.autoDisabledReason === undefined ? null : (
          <p className="type-body text-rust measure-prose">
            {`The platform took this integration out of circulation: ${integration.autoDisabledReason}. Fix the fault, then enable it again — enabling clears the failure count.`}
          </p>
        )}

        {validation === undefined ? null : (
          <div className="gap-hair flex flex-col">
            <span className="type-label-mono text-graphite">
              {validation.ok ? 'validation passed' : 'validation failed'}
            </span>
            <ul className="gap-hair flex flex-col">
              {validation.checks.map((check) => (
                <li key={check.name} className="type-data-mono text-ink">
                  {`${check.name}: ${check.ok ? 'ok' : (check.detail ?? 'failed')}`}
                </li>
              ))}
            </ul>
          </div>
        )}

        {error === undefined ? null : <FieldError code={error.code} action={error.action} />}

        <div className="gap-close flex flex-wrap">
          <Button variant="secondary" onClick={onEdit}>
            Edit
          </Button>
          {pending ? (
            <Button variant="secondary" pending readout="Working">
              Check the connection
            </Button>
          ) : (
            <Button variant="secondary" onClick={onValidate}>
              Check the connection
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => {
              onSetEnabled(!integration.enabled)
            }}
          >
            {integration.enabled ? 'Disable' : 'Enable'}
          </Button>
          {integration.enabled ? (
            <Button variant="secondary" onClick={onRunNow}>
              Run now
            </Button>
          ) : null}
        </div>
      </CardBody>
    </Card>
  )
}
