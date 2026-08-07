'use client'

import { ElapsedReadout } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import { Button, FieldError, StateChip } from '@sisyphus-admin/components/ui'
import { PromptField } from '@sisyphus-admin/components/workflows/new'

import type { CorrectionReadout } from './correction-list'
import { CorrectionList } from './correction-list'
import type { SupervisionCommandName, SupervisionStatus } from './supervision-status'
import {
  acceptsCorrections,
  availableSupervisionActions,
  supervisionReadout,
} from './supervision-status'

/**
 * **Pause · Resume · Stop · Send correction (T095, FR-015, FR-049, FR-081, SC-003).**
 *
 * These mount into `workflows/supervision-slot.tsx`, which has been holding the space and saying so.
 *
 * ## The one thing this component must not do
 *
 * It must not say "paused" until the executor has acknowledged. The status it renders comes from
 * {@link supervisionReadout}, and `./supervision-status.ts` is where that rule is enforced and
 * asserted — a queued pause reads `PAUSE REQUESTED`, with a sentence saying in plain words that the
 * agent is still working. This component has no state of its own from which it could conclude
 * otherwise: it is given a status and it renders it.
 *
 * The consequence is visible rather than hidden. While a pause is queued the card keeps saying the
 * run is still going, and the Stop button stays available — because "I asked for a pause and it has
 * not happened yet" is precisely the moment an operator most needs to be able to stop the run.
 *
 * ## Refusals are field errors, not toasts
 *
 * An already-finished answer (FR-081) is not an error at all — it is the server explaining that the
 * run finished before the request reached it — so it is rendered as a notice on the card, in the
 * server's own words, and the controls disappear because there is nothing left to act on. A genuine
 * refusal attaches to the control that produced it, so it sits where the operator was looking and
 * can be re-read.
 *
 * ## No literal colour, size or radius (SC-015)
 *
 * Everything is `src/components/ui` plus layout tokens. There is no `style` attribute anywhere in
 * this directory and the colocated tests assert it.
 */

/** What the panel is currently waiting on, so a button becomes a live readout rather than a spinner. */
export interface SupervisionPendingAction {
  readonly kind: SupervisionCommandName | 'correct'
  /** `Date.now()` when the mutation started. */
  readonly startedAt: number
}

interface SupervisionControlsProps {
  readonly workflowId: string
  /** Derived by the caller with `supervisionStatus`. Never inferred from a button press. */
  readonly status: SupervisionStatus
  readonly correctionBody: string
  readonly onCorrectionBodyChange: (body: string) => void
  readonly onCommand: (command: SupervisionCommandName) => void
  readonly onSendCorrection: () => void
  readonly pending?: SupervisionPendingAction
  /** A refusal from the server, attached to the correction field. */
  readonly correctionError?: FieldErrorContent
  /**
   * The server's already-finished explanation (FR-081), verbatim. Present when a request was
   * recorded but not applied.
   */
  readonly alreadyFinished?: string
  readonly corrections: readonly CorrectionReadout[]
}

export const SupervisionControls = ({
  workflowId,
  status,
  correctionBody,
  onCorrectionBodyChange,
  onCommand,
  onSendCorrection,
  pending,
  correctionError,
  alreadyFinished,
  corrections,
}: SupervisionControlsProps) => {
  const readout = supervisionReadout(status)
  const actions = availableSupervisionActions(status)
  const busy = pending !== undefined
  const canCorrect = acceptsCorrections(status)

  return (
    <div className="gap-default flex flex-col">
      <div className="gap-default flex flex-wrap items-center">
        <StateChip>{readout.chip}</StateChip>
        <span className="type-data-mono text-graphite">{workflowId}</span>
      </div>

      <p className="type-body text-graphite measure-prose">{readout.explanation}</p>

      {alreadyFinished === undefined ? null : (
        <p role="status" className="type-body text-ink measure-prose">
          {alreadyFinished}
        </p>
      )}

      {actions.length === 0 ? null : (
        <div className="gap-tight flex flex-wrap items-center">
          {actions.map((action) =>
            pending?.kind === action.kind ? (
              <Button
                key={action.kind}
                variant={action.variant}
                pending
                readout={<ElapsedReadout verb={action.verb} startedAt={pending.startedAt} />}
              />
            ) : (
              <Button
                key={action.kind}
                variant={action.variant}
                disabled={busy}
                onClick={() => {
                  onCommand(action.kind)
                }}
              >
                {action.label}
              </Button>
            ),
          )}
        </div>
      )}

      {canCorrect ? (
        <div className="gap-tight flex flex-col">
          <PromptField
            label="Correction"
            hint="delivered as an extra user turn in the same conversation, in the order written"
            value={correctionBody}
            disabled={busy}
            onChange={onCorrectionBodyChange}
          />

          {correctionError === undefined ? null : (
            <FieldError code={correctionError.code} action={correctionError.action} />
          )}

          <div className="gap-tight flex flex-wrap items-center">
            {pending?.kind === 'correct' ? (
              <Button
                pending
                readout={<ElapsedReadout verb="Sending" startedAt={pending.startedAt} />}
              />
            ) : (
              <Button
                variant="primary"
                disabled={busy || correctionBody.trim().length === 0}
                onClick={onSendCorrection}
              >
                Send correction
              </Button>
            )}
          </div>
        </div>
      ) : null}

      <CorrectionList corrections={corrections} />
    </div>
  )
}
