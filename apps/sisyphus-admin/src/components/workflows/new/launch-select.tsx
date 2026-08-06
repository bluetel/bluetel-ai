'use client'

import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import { fieldControlVariants, FieldError, FieldLabel } from '@sisyphus-admin/components/ui'
import { cn } from '@sisyphus-admin/lib/cn'
import { useId } from 'react'

/**
 * The launch form's picker.
 *
 * ## Why this exists here rather than in `src/components/ui`
 *
 * **The primitive set has no select.** It has a text control, and this form needs six pickers —
 * workspace, setup bundle, workflow type, model, capacity and the workspace-source choice itself.
 * Six hand-styled `<select>` elements would be six chances to drift, which is the duplication
 * FR-033 forbids.
 *
 * So this is one component, and its styling is **not** hand-rolled: it composes
 * `fieldControlVariants`, the same `cva` the text control is built from, so the picker and the
 * field next to it cannot come apart. The precedent is `IssueGrantForm`, which styles a native
 * select from the field-control tokens; this goes one step further by taking the variant function
 * itself rather than restating its classes.
 *
 * The day a second screen needs a picker, this belongs in `src/components/ui` as `Select` and this
 * file becomes an import. It is not there yet because a primitive extracted from one caller is a
 * guess about the second.
 */

/** One choice. `label` is what the operator reads; `value` is what the request carries. */
export interface LaunchOption {
  readonly value: string
  readonly label: string
}

interface LaunchSelectProps {
  /** Always rendered above the control, never as a placeholder standing in for one (FR-031). */
  label: string
  value: string
  options: readonly LaunchOption[]
  /** The empty first choice — what the control says before anything is chosen. */
  placeholder: string
  onChange: (value: string) => void
  /** One sentence under the label, for a choice whose consequence is not obvious. */
  hint?: string
  error?: FieldErrorContent
  disabled?: boolean
}

/**
 * A labelled picker that reports its own state (FR-023, FR-031).
 *
 * The label's `htmlFor`, the control's `id` and the error's `aria-describedby` all come from one
 * generated id, exactly as `Field` does it, so the association cannot be got wrong by a caller
 * passing three strings that nearly match.
 */
export const LaunchSelect = ({
  label,
  value,
  options,
  placeholder,
  onChange,
  hint,
  error,
  disabled = false,
}: LaunchSelectProps) => {
  const id = useId()
  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const invalid = error !== undefined

  return (
    <div className="gap-tight flex flex-col">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {hint === undefined ? null : (
        <p id={hintId} className="type-data-mono text-graphite">
          {hint}
        </p>
      )}
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : hint === undefined ? undefined : hintId}
        data-state={invalid ? 'invalid' : 'valid'}
        onChange={(event) => {
          onChange(event.target.value)
        }}
        className={cn(fieldControlVariants({ invalid }))}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {invalid ? <FieldError id={errorId} code={error.code} action={error.action} /> : null}
    </div>
  )
}
