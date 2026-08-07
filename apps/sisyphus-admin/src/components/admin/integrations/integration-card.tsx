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
import type { RunHistoryRow } from './run-history'

interface IntegrationCardProps {
  integration: IntegrationReadouts
  onEdit: () => void
  onSetEnabled: (enabled: boolean) => void
  onValidate: () => void
  onRunNow: () => void
  /** Open the two-step delete (FR-097). */
  onRequestDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
  /** True while this card is the one asking for confirmation. */
  confirmingDelete?: boolean
  /** Load the tick history (FR-105). */
  onShowHistory: () => void
  onHideHistory: () => void
  /** The history, once read. `undefined` while it has not been asked for. */
  history?: readonly RunHistoryRow[]
  /** True when the recent ticks match work and start none of it (FR-105). */
  stalled?: boolean
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
 *
 * ## Delete is two steps, and is offered even when it will be refused
 *
 * The opposite of the rule above, for a reason. "Run now" on a disabled board is refused because of
 * a state the card is *already showing* — the refusal would tell an admin nothing new. Delete is
 * refused because of what the integration has *started* (FR-131), which is a count the server holds
 * and the admin is asking about by pressing the button. Hiding it would answer "you cannot" without
 * ever saying "because six workflows point at this".
 *
 * ## The history is loaded on request, not with the list
 *
 * FR-105 asks for the run history to be visible so a silently-failing connector is detectable. The
 * card shows the last tick always, and the rest when asked — fifty correlated run queries on page
 * load is a different thing from the requirement, and a slower one.
 */
export const IntegrationCard = ({
  integration,
  onEdit,
  onSetEnabled,
  onValidate,
  onRunNow,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
  confirmingDelete = false,
  onShowHistory,
  onHideHistory,
  history,
  stalled = false,
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

        {stalled ? (
          <p className="type-body text-rust measure-prose">
            The last three ticks each matched tickets and started nothing. Those ticks did not fail,
            so the consecutive-failure count has not moved and the platform has not taken this board
            out of circulation — check the mappings and the ceilings.
          </p>
        ) : null}

        {history === undefined ? null : (
          <div className="gap-hair flex flex-col">
            <span className="type-label-mono text-graphite">tick history</span>
            {history.length === 0 ? (
              <span className="type-data-mono text-graphite">
                this integration has not ticked yet
              </span>
            ) : (
              <ul className="gap-hair flex flex-col">
                {history.map((row) => (
                  <li
                    key={row.id}
                    className={`type-data-mono ${row.failed ? 'text-rust' : 'text-ink'}`}
                  >
                    {`${row.startedAt} — ${row.trigger}, ${row.duration} — ${row.counts}${
                      row.error === undefined ? '' : ` — failed: ${row.error}`
                    }`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {error === undefined ? null : <FieldError code={error.code} action={error.action} />}

        {confirmingDelete ? (
          <p className="type-body text-rust measure-prose">
            {`Delete ${integration.name}? Its schedule stops and its configuration goes. This is refused if it has ever started a workflow, because those runs record which integration launched them.`}
          </p>
        ) : null}

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
          {history === undefined ? (
            <Button variant="secondary" onClick={onShowHistory}>
              Tick history
            </Button>
          ) : (
            <Button variant="secondary" onClick={onHideHistory}>
              Hide history
            </Button>
          )}
          {confirmingDelete ? (
            <>
              <Button variant="secondary" onClick={onCancelDelete}>
                Keep it
              </Button>
              {pending ? (
                <Button variant="secondary" pending readout="Working">
                  Delete
                </Button>
              ) : (
                <Button variant="secondary" onClick={onConfirmDelete}>
                  Delete
                </Button>
              )}
            </>
          ) : (
            <Button variant="secondary" onClick={onRequestDelete}>
              Delete
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
