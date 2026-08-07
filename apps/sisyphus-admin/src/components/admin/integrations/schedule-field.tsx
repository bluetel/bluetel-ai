'use client'

import { DataReadout } from '@sisyphus-admin/components/admin/data-readout'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import { FieldControl, FieldError, FieldLabel, FOCUS_RING } from '@sisyphus-admin/components/ui'
import { cn } from '@sisyphus-admin/lib/cn'
import { useId } from 'react'

import {
  CUSTOM_SCHEDULE_ID,
  expressionForPreset,
  presetForExpression,
  SCHEDULE_PRESETS,
  scheduleReadback,
  timezoneOptions,
} from './schedule-presets'

interface ScheduleFieldProps {
  expression: string
  timezone: string
  onExpressionChange: (expression: string) => void
  onTimezoneChange: (timezone: string) => void
  /** Injectable so a rendering test states the clock rather than racing it. */
  now?: Date
  expressionError?: FieldErrorContent
  timezoneError?: FieldErrorContent
}

/**
 * Choosing when a board is polled (T121, FR-154, FR-155).
 *
 * ## The readback is the control, not a decoration beside it
 *
 * FR-154 will not let a schedule be saved without a plain-language readback **and** the next five
 * fire times. Both are rendered here, and `integration-form-values.ts` refuses to submit an
 * expression that produces neither — so the two halves cannot drift into a screen that shows a
 * readback the form ignores.
 *
 * The fire times are shown in **the integration's own timezone**, labelled with it, and never in
 * the reader's (FR-155). An admin in London configuring a Sydney board is the case that matters: a
 * list of times in their own clock would be correct instants and the wrong answer to the question
 * they are asking, which is "when does this board get looked at during its own working day".
 *
 * ## Presets first, raw cron as the escape hatch
 *
 * Choosing a preset writes its expression into the same field the raw editor uses, so there is one
 * value and it is the one that runs. Selecting "Custom" changes nothing about the expression — it
 * only reveals the text control, so switching to custom to look at the cron and switching back
 * cannot silently rewrite the schedule.
 *
 * The pickers are native `select`s for the reason `IssueGrantForm` gives: the panel's primitive set
 * has no combo-box, and inventing one here would be the hand-rolled duplicate FR-033 forbids.
 */
export const ScheduleField = ({
  expression,
  timezone,
  onExpressionChange,
  onTimezoneChange,
  now,
  expressionError,
  timezoneError,
}: ScheduleFieldProps) => {
  const id = useId()
  const presetId = presetForExpression(expression)
  const readback = scheduleReadback(expression, timezone, now)
  const selectClass = cn(
    'type-body w-full bg-paper text-ink',
    'rounded-sm p-close border border-hairline-hi',
    'hover:border-ink',
    FOCUS_RING,
  )

  return (
    <div className="gap-default flex flex-col">
      <div className="gap-tight flex flex-col">
        <FieldLabel htmlFor={`${id}-preset`}>Schedule</FieldLabel>
        <select
          id={`${id}-preset`}
          value={presetId}
          className={selectClass}
          onChange={(event) => {
            const chosen = expressionForPreset(event.target.value)
            // Selecting "Custom" reveals the raw control and leaves the expression alone.
            if (chosen !== undefined) {
              onExpressionChange(chosen)
            }
          }}
        >
          {SCHEDULE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
          <option value={CUSTOM_SCHEDULE_ID}>Custom — write a cron expression</option>
        </select>
      </div>

      {presetId === CUSTOM_SCHEDULE_ID ? (
        <div className="gap-tight flex flex-col">
          <FieldLabel htmlFor={`${id}-cron`}>Cron expression</FieldLabel>
          <FieldControl
            id={`${id}-cron`}
            value={expression}
            spellCheck={false}
            placeholder="0/15 * * * *"
            invalid={expressionError !== undefined}
            onChange={(event) => {
              onExpressionChange(event.target.value)
            }}
          />
        </div>
      ) : null}

      <div className="gap-tight flex flex-col">
        <FieldLabel htmlFor={`${id}-timezone`}>Timezone</FieldLabel>
        <select
          id={`${id}-timezone`}
          value={timezone}
          className={selectClass}
          onChange={(event) => {
            onTimezoneChange(event.target.value)
          }}
        >
          {timezoneOptions(timezone).map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
        <p className="type-body text-graphite measure-prose">
          The schedule is evaluated in this timezone, so a wall-clock time stays at its wall-clock
          time across a daylight-saving change rather than drifting by an hour.
        </p>
      </div>

      <div className="gap-tight border-hairline p-close flex flex-col rounded-sm border">
        <DataReadout label="reads as" value={readback.description} />
        {readback.readable ? (
          <div className="gap-hair flex flex-col">
            <span className="type-label-mono text-graphite">
              {`next ${String(readback.nextRuns.length)} runs — ${readback.timezone}`}
            </span>
            <ul className="gap-hair flex flex-col">
              {readback.nextRuns.map((run) => (
                <li key={run} className="type-data-mono text-ink">
                  {run}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="type-body text-rust measure-prose">
            This schedule cannot be shown, so it cannot be saved. Pick a preset, or write an
            expression the panel can read.
          </p>
        )}
      </div>

      {expressionError === undefined ? null : (
        <FieldError code={expressionError.code} action={expressionError.action} />
      )}
      {timezoneError === undefined ? null : (
        <FieldError code={timezoneError.code} action={timezoneError.action} />
      )}
    </div>
  )
}
