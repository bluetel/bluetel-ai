'use client'

import { cn } from '@sisyphus-admin/lib/cn'
import type { InputHTMLAttributes } from 'react'
import { useId } from 'react'

import { FieldControl } from './field-control'
import { FieldError, type FieldErrorContent } from './field-error'
import { FieldLabel } from './field-label'

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  /** The label, always rendered above the control. Required — a field without one is a defect. */
  label: string
  /** Present when the value was refused. Carries a machine code and a next action, never a dead end. */
  error?: FieldErrorContent
  /** Wrapper class, for layout only. */
  className?: string
}

/**
 * Label above control above error, wired together (FR-031).
 *
 * The three parts exist separately for the cases that need them apart, but this is the shape almost
 * every form wants, and assembling it here is what makes the association reliable: the label's
 * `htmlFor`, the control's `id` and the error's `aria-describedby` all come from one generated id
 * rather than from a caller remembering to pass three matching strings.
 *
 * `'use client'` because `useId` is a hook. The control it wraps is not a client component itself,
 * so a server-rendered read-only field can still use `FieldControl` directly.
 */
export const Field = ({ label, error, className, ...control }: FieldProps) => {
  const id = useId()
  const errorId = `${id}-error`

  return (
    <div className={cn('gap-tight flex flex-col', className)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <FieldControl
        {...control}
        id={id}
        invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errorId}
      />
      {error === undefined ? null : (
        <FieldError id={errorId} code={error.code} action={error.action} />
      )}
    </div>
  )
}
