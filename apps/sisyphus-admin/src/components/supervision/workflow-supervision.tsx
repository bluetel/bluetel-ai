'use client'

import type { WorkflowState } from '@bluetel-ai/sisyphus-api/client'
import { describeTrpcError } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import { FieldError } from '@sisyphus-admin/components/ui'
import { api } from '@sisyphus-admin/trpc'
import { useState } from 'react'

import type { SupervisionPendingAction } from './controls'
import { SupervisionControls } from './controls'
import type { SupervisionCommandResult } from './pending-command'
import {
  alreadyFinishedExplanation,
  isCommandAcknowledged,
  nextPendingCommand,
  supersededNotice,
  toCorrectionReadouts,
} from './pending-command'
import type { PendingSupervisionCommand, SupervisionCommandName } from './supervision-status'
import { supervisionStatus } from './supervision-status'

/**
 * **The supervision controls, wired (T208, FR-015, FR-049, FR-081, SC-003).**
 *
 * `./controls.tsx` is deliberately stateless — it is given a status and renders it — and this is
 * the component that decides what that status is. It mounts into
 * `components/workflows/supervision-slot.tsx` as that slot's `children`, which is the only change
 * the slot needed.
 *
 * ## "Paused" comes from the run, not from the button
 *
 * The one rule the whole task exists for. `workflow.pause` resolves as soon as a queue row is
 * written; it does not move `workflows.state`, and the agent is still working when the promise
 * settles. So `onSuccess` here does exactly one thing with the answer — it starts a wait — and the
 * wait ends only when {@link isCommandAcknowledged} sees the state the executor's acknowledgement
 * wrote. There is no assignment anywhere in this file that could set a status directly, and the
 * status is **derived on every render** rather than stored, so there is not even a stale copy of it
 * to go wrong.
 *
 * ## Which is why the run is re-read
 *
 * A panel that never re-reads would sit on `PAUSE REQUESTED` for ever and FR-015 requires the
 * transition without a manual reload. `workflow.byId` is polled by the detail panel while the run
 * is unfinished — see `workflow-detail-panel.tsx` — and the state it returns arrives here as
 * {@link WorkflowSupervisionProps.workflowState}. Invalidating `byId` on a settled command shortens
 * the first wait; the poll is what closes it.
 *
 * ## Refusals
 *
 * An already-finished answer is not an error (FR-081): it is passed to the controls, which render
 * the server's own sentence and drop the buttons, because there is nothing left to act on. A
 * genuine refusal from the transport becomes a field error, and `NOT_FOUND` and `FORBIDDEN` are
 * mapped to the **same** content — a run the caller may not see must not be distinguishable from
 * one that does not exist, and a supervision button whose refusal varied by code would be the
 * lookup FR-190 spends the API surface avoiding.
 */

/** How often the corrections list is re-read while a run is still going. */
export const CORRECTIONS_POLL_MS = 5_000

/**
 * The one thing this control says when the server refuses.
 *
 * Identical for `NOT_FOUND` and `FORBIDDEN`, on purpose — see the module comment.
 */
export const SUPERVISION_REFUSED: FieldErrorContent = {
  code: 'E_RUN_NOT_FOUND',
  action: 'Reload the run — there is nothing here to supervise.',
}

/**
 * Describe a refusal from a supervision mutation.
 *
 * @param failure - Whatever the mutation rejected with.
 * @returns A code and a next action which are identical for `NOT_FOUND` and `FORBIDDEN`.
 */
export const describeSupervisionError = (failure: unknown): FieldErrorContent =>
  describeTrpcError(failure, { NOT_FOUND: SUPERVISION_REFUSED, FORBIDDEN: SUPERVISION_REFUSED })

interface WorkflowSupervisionProps {
  /**
   * The id `workflow.byId` returned — **not** the id from the URL.
   *
   * The same rule the watch control follows: a caller who cannot see the run has no value to pass,
   * so there are no buttons to press and no refusal to read a fact out of (FR-190).
   */
  readonly workflowId: string
  /** The state the server has recorded. The only thing that may be read as a pause. */
  readonly workflowState: WorkflowState
}

export const WorkflowSupervision = ({ workflowId, workflowState }: WorkflowSupervisionProps) => {
  const [awaiting, setAwaiting] = useState<PendingSupervisionCommand | undefined>(undefined)
  const [inFlight, setInFlight] = useState<SupervisionPendingAction | undefined>(undefined)
  const [correctionBody, setCorrectionBody] = useState('')
  const [correctionError, setCorrectionError] = useState<FieldErrorContent | undefined>(undefined)
  const [commandError, setCommandError] = useState<FieldErrorContent | undefined>(undefined)
  const [alreadyFinished, setAlreadyFinished] = useState<string | undefined>(undefined)
  const [superseded, setSuperseded] = useState<string | undefined>(undefined)

  const utils = api.useUtils()
  const pause = api.workflow.pause.useMutation()
  const resume = api.workflow.resume.useMutation()
  const stop = api.workflow.stop.useMutation()
  const correct = api.workflow.correct.useMutation()

  // **Derived, never stored.** A request is only outstanding until the recorded state shows the
  // executor acted on it, and computing that here means there is no second copy of "is it paused?"
  // for an effect to update late or forget to clear.
  const outstanding =
    awaiting !== undefined && isCommandAcknowledged({ command: awaiting.command, workflowState })
      ? undefined
      : awaiting

  const status = supervisionStatus({ workflowState, pendingCommand: outstanding })

  const corrections = api.workflow.corrections.useQuery(
    { workflowId },
    { refetchInterval: status === 'finished' ? false : CORRECTIONS_POLL_MS },
  )

  const settleCommand =
    (command: SupervisionCommandName, requestedAt: number) =>
    (result: SupervisionCommandResult) => {
      setInFlight(undefined)
      setAwaiting((held) => nextPendingCommand({ held, command, result, requestedAt }))
      setAlreadyFinished(alreadyFinishedExplanation(result))
      setSuperseded(supersededNotice(result))
      // Shortens the wait for the acknowledgement; it does not stand in for one.
      void utils.workflow.byId.invalidate({ workflowId })
    }

  const refuseCommand = (failure: unknown) => {
    setInFlight(undefined)
    setCommandError(describeSupervisionError(failure))
  }

  const runCommand = (command: SupervisionCommandName) => {
    const requestedAt = Date.now()

    setInFlight({ kind: command, startedAt: requestedAt })
    setCommandError(undefined)
    setAlreadyFinished(undefined)
    setSuperseded(undefined)

    const mutations = { pause, resume, stop }

    mutations[command].mutate(
      { workflowId },
      { onSuccess: settleCommand(command, requestedAt), onError: refuseCommand },
    )
  }

  const sendCorrection = () => {
    const body = correctionBody.trim()

    if (body.length === 0) {
      return
    }

    setInFlight({ kind: 'correct', startedAt: Date.now() })
    setCorrectionError(undefined)
    setAlreadyFinished(undefined)

    correct.mutate(
      { workflowId, body },
      {
        onSuccess: (result) => {
          setInFlight(undefined)
          setAlreadyFinished(alreadyFinishedExplanation(result))
          // Cleared only when the server took it. A refused correction stays in the field, because
          // the text is the person's and re-typing it is not a recovery step.
          if (result.applied) {
            setCorrectionBody('')
          }
          void utils.workflow.corrections.invalidate({ workflowId })
        },
        onError: (failure) => {
          setInFlight(undefined)
          setCorrectionError(describeSupervisionError(failure))
        },
      },
    )
  }

  return (
    <div className="gap-default flex flex-col">
      {commandError === undefined ? null : <FieldError {...commandError} />}

      {superseded === undefined ? null : (
        <p role="status" className="type-body text-ink measure-prose">
          {superseded}
        </p>
      )}

      <SupervisionControls
        workflowId={workflowId}
        status={status}
        correctionBody={correctionBody}
        onCorrectionBodyChange={setCorrectionBody}
        onCommand={runCommand}
        onSendCorrection={sendCorrection}
        pending={inFlight}
        correctionError={correctionError}
        alreadyFinished={alreadyFinished}
        corrections={toCorrectionReadouts(corrections.data ?? [])}
      />
    </div>
  )
}
