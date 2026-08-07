'use client'

import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import { fieldControlVariants, FieldError, FieldLabel } from '@sisyphus-admin/components/ui'
import { cn } from '@sisyphus-admin/lib/cn'
import { useId } from 'react'

/**
 * The prompt — the one field that is always required, whichever way the run was configured
 * (FR-122).
 *
 * ## Why this exists here rather than in `src/components/ui`
 *
 * **The primitive set has no textarea.** `FieldControl` is an `<input>`, and a prompt typed into a
 * single-line input is a prompt nobody proof-reads: the operator can see the last forty characters
 * of what they are about to spend money running. So the control is a `textarea`, styled from
 * `fieldControlVariants` — the same `cva` the text control uses — rather than from classes
 * restated here.
 *
 * Same rule as `LaunchSelect`: a second screen — the profile admin surface, whose prompt preamble
 * is the same kind of text — now needs multi-line input, so this belongs in `src/components/ui` as
 * `TextArea` and this file becomes an import. Until it moves, the label and hint are props rather
 * than a second copy of the control, because a copy is what the promotion exists to prevent.
 */

/** How many lines are visible before it scrolls. Enough to read a paragraph without scrolling. */
const VISIBLE_LINES = 8

interface PromptFieldProps {
  value: string
  onChange: (value: string) => void
  /** Defaults to the launch form's own field. Overridden by the other screen that writes prompts. */
  label?: string
  hint?: string
  error?: FieldErrorContent
  disabled?: boolean
}

/** A labelled, multi-line control that reports its own state (FR-023, FR-031). */
export const PromptField = ({
  value,
  onChange,
  label = 'Prompt',
  hint = 'what the agent is being asked to do. sent as written',
  error,
  disabled = false,
}: PromptFieldProps) => {
  const id = useId()
  const errorId = `${id}-error`
  const invalid = error !== undefined

  return (
    <div className="gap-tight flex flex-col">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <p className="type-data-mono text-graphite">{hint}</p>
      <textarea
        id={id}
        value={value}
        rows={VISIBLE_LINES}
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        data-state={invalid ? 'invalid' : 'valid'}
        onChange={(event) => {
          onChange(event.target.value)
        }}
        className={cn(fieldControlVariants({ invalid }), 'resize-y')}
      />
      {invalid ? <FieldError id={errorId} code={error.code} action={error.action} /> : null}
    </div>
  )
}
