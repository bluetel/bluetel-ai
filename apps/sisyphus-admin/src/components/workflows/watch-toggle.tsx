'use client'

import { ChangeNotice, describeTrpcError, ElapsedReadout } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FieldError,
  StateChip,
} from '@sisyphus-admin/components/ui'
import type { RouterOutputs } from '@sisyphus-admin/trpc'
import { api } from '@sisyphus-admin/trpc'
import { useState } from 'react'

/**
 * Watch / Unwatch, on the run detail view (T160, FR-138, FR-190).
 *
 * ## This control must not become an existence oracle
 *
 * `workflow.watch` and `workflow.unwatch` are `scopedProcedure`, and their first act is
 * `requireWorkflowInScope`: a run the caller may not see is reported as **absent**, with the same
 * `NOT_FOUND` and the same message a nonexistent id gets. The server is careful precisely so that a
 * mutation cannot be used to enumerate ids. Three things here are what stop the panel handing that
 * back anyway.
 *
 * 1. **The control is never rendered for a run that has not resolved.** Its `workflowId` is the id
 *    `workflow.byId` *returned*, not the id in the URL — see the mount in
 *    `workflow-detail-panel.tsx`. For an out-of-scope or nonexistent run there is no such value, so
 *    there is no control: the screen is the not-found card and nothing else. A toggle rendered
 *    beside a "no such run" message, or rendered eagerly while the read was still in flight, would
 *    be a button whose refusal is a lookup anyone could run over the whole id space.
 * 2. **A refusal says one thing, whatever its code.** {@link describeWatchError} maps `FORBIDDEN`
 *    onto the very same content as `NOT_FOUND`, deliberately. The scoped procedures do not answer
 *    `FORBIDDEN` today; if one ever did, the default mapping would render "ask an admin", which
 *    means "this run exists and you may not have it" — the one sentence FR-190 spends the whole API
 *    surface avoiding. The panel refuses to draw a distinction it must not draw.
 * 3. **Nothing is flipped optimistically.** The stance comes only from a result the server
 *    returned: {@link WatchToggle} holds the last `WatchResult` and derives everything from it. An
 *    optimistic flip would show `watching` for the moment before a refusal arrived, and "the button
 *    went green briefly" is an answer to "does this run exist?".
 *
 * ## Why both controls are offered before anything has been pressed
 *
 * The API has no read for "do I watch this run?" — `isWatching` exists in the resolvers but is not
 * mounted on the interactive surface — so on first render the panel genuinely does not know, and it
 * says so rather than guessing. Guessing would be worse than useless here: rendering `Watch` for
 * someone who already watches makes the button a no-op that appears to have done something, and
 * FR-188's cascade means a watch can also disappear underneath a person when a grant is revoked.
 *
 * Both mutations are idempotent — `onConflictDoNothing` on the way in, a `delete` that matches
 * nothing on the way out — and both report `changed`, so pressing the one that was already true is
 * safe and is reported honestly as "nothing changed" rather than as success.
 */

/** What either mutation answers with. From the router, never mirrored by hand. */
export type WatchResult = RouterOutputs['workflow']['watch']

/**
 * The one thing this control says when the server refuses.
 *
 * Not "you do not have permission", and not a different sentence for a different code. See rule 2
 * in the module comment.
 */
export const WATCH_REFUSED: FieldErrorContent = {
  code: 'E_RUN_NOT_FOUND',
  action: 'Reload the run — there is nothing here to follow.',
}

/**
 * Describe a refusal from `watch` or `unwatch`.
 *
 * @param failure - Whatever the mutation rejected with.
 * @returns A code and a next action which are **identical** for `NOT_FOUND` and `FORBIDDEN`.
 */
export const describeWatchError = (failure: unknown): FieldErrorContent =>
  describeTrpcError(failure, { NOT_FOUND: WATCH_REFUSED, FORBIDDEN: WATCH_REFUSED })

/** What the panel says after a watch or an unwatch settled. */
export interface WatchNotice {
  readonly readout: string
  readonly detail: string
}

/**
 * Report what the server actually did.
 *
 * `changed: false` is not a failure — watching a run twice is one watch — so it is reported as the
 * state being already held rather than as an error a person has to interpret.
 *
 * @param result - The mutation's answer.
 */
export const describeWatchOutcome = (result: WatchResult): WatchNotice => {
  if (result.watching) {
    return {
      readout: result.changed ? 'watching' : 'already watching',
      detail: result.changed
        ? 'You will be notified about this run as though it were yours, subject to your notification settings.'
        : 'You were already following this run. Nothing changed.',
    }
  }

  return {
    readout: result.changed ? 'not watching' : 'was not watching',
    detail: result.changed
      ? 'You will not be notified about this run again unless you follow it once more.'
      : 'You were not following this run. Nothing changed.',
  }
}

interface WatchToggleProps {
  /**
   * The id `workflow.byId` returned — **not** the id from the URL.
   *
   * That is rule 1 in the module comment, expressed as a prop: a caller who cannot see the run has
   * no value to pass, so there is nothing to render.
   */
  readonly workflowId: string
}

export const WatchToggle = ({ workflowId }: WatchToggleProps) => {
  const [outcome, setOutcome] = useState<WatchResult | undefined>(undefined)
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  const [error, setError] = useState<FieldErrorContent | undefined>(undefined)

  const watch = api.workflow.watch.useMutation()
  const unwatch = api.workflow.unwatch.useMutation()

  const settle = (result: WatchResult) => {
    setStartedAt(undefined)
    setError(undefined)
    // The only place the stance moves, and it moves to what the server said. See rule 3.
    setOutcome(result)
  }

  const refuse = (failure: unknown) => {
    setStartedAt(undefined)
    setError(describeWatchError(failure))
  }

  const press = (wanted: boolean) => {
    setStartedAt(Date.now())
    setError(undefined)
    const mutation = wanted ? watch : unwatch
    mutation.mutate({ workflowId }, { onSuccess: settle, onError: refuse })
  }

  const pending = startedAt !== undefined
  const notice = outcome === undefined ? undefined : describeWatchOutcome(outcome)
  const canWatch = !outcome?.watching
  const canUnwatch = outcome === undefined || outcome.watching

  return (
    <Card aria-label="Watching">
      <CardHeader>
        <span>notifications for this run</span>
        <StateChip>
          {outcome === undefined ? 'not read' : outcome.watching ? 'watching' : 'not watching'}
        </StateChip>
      </CardHeader>

      <CardBody className="gap-default flex flex-col">
        <p className="type-body text-graphite measure-prose">
          Follow this run to be notified about it as though it were yours, whoever owns it.
          {outcome === undefined
            ? ' This panel cannot read whether you already follow it — the API offers no such read — so both choices are offered, and pressing the one that is already true changes nothing.'
            : ''}
        </p>

        {error === undefined ? null : <FieldError {...error} />}

        {notice === undefined ? null : (
          <ChangeNotice readout={notice.readout} detail={notice.detail} />
        )}

        <div className="gap-tight flex flex-wrap items-center">
          {pending ? (
            <Button pending readout={<ElapsedReadout verb="Saving" startedAt={startedAt} />} />
          ) : (
            <>
              {canWatch ? (
                <Button
                  onClick={() => {
                    press(true)
                  }}
                >
                  Watch this run
                </Button>
              ) : null}
              {canUnwatch ? (
                <Button
                  variant="quiet"
                  onClick={() => {
                    press(false)
                  }}
                >
                  Stop watching
                </Button>
              ) : null}
            </>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
