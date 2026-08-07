import { cn } from '@sisyphus-admin/lib/cn'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { buttonVariants, type ButtonVariant } from './button-variants'

interface ButtonBaseProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
}

/**
 * In flight, a button's label **becomes** a live readout — `Running 04:21`, not a spinner. A spinner
 * says something is happening, which the operator already knew; the readout says how long it has
 * been happening, which is the thing they wanted.
 *
 * The union is what makes that a rule rather than a suggestion: `pending` cannot be set without a
 * `readout` to replace the label with, so the spinner-shaped implementation does not type-check.
 */
type ButtonPendingProps =
  | { pending: true; readout: ReactNode }
  | { pending?: false; readout?: never }

export type ButtonProps = ButtonBaseProps & ButtonPendingProps

/**
 * The panel's one button (FR-033).
 *
 * Every interactive element reports its state (FR-023), so the rendered element carries both the
 * assistive-technology signal (`aria-busy`, `disabled`) and a `data-state` attribute that says the
 * same thing in one place a test, a stylesheet or a screenshot can read.
 */
export const Button = ({
  variant,
  pending = false,
  readout,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) => {
  const isDisabled = disabled ?? pending

  return (
    <button
      {...rest}
      type={type}
      disabled={isDisabled}
      aria-busy={pending}
      data-state={pending ? 'pending' : isDisabled ? 'disabled' : 'idle'}
      className={cn(buttonVariants({ variant }), className)}
    >
      {pending ? readout : children}
    </button>
  )
}
