import { cn } from '@sisyphus-admin/lib/cn'
import type { InputHTMLAttributes } from 'react'

import { fieldControlVariants } from './field-control-variants'

export interface FieldControlProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Whether the value has been refused. Drives the border, `aria-invalid` and the reported state. */
  invalid?: boolean
}

/**
 * The panel's text input.
 *
 * Like every interactive element it reports its own state (FR-023): `aria-invalid` for assistive
 * technology, and a `data-state` attribute that says the same thing to a stylesheet or a test.
 */
export const FieldControl = ({ invalid = false, className, ...rest }: FieldControlProps) => (
  <input
    {...rest}
    aria-invalid={invalid}
    data-state={invalid ? 'invalid' : 'valid'}
    className={cn(fieldControlVariants({ invalid }), className)}
  />
)
