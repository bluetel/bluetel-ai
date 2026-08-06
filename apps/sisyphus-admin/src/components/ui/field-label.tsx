import { cn } from '@sisyphus-admin/lib/cn'
import type { LabelHTMLAttributes } from 'react'

/**
 * A field's label: `label-mono` in graphite, sitting **above** the control (FR-031).
 *
 * Never a placeholder standing in for a label and never floating — a placeholder disappears exactly
 * when the operator is mid-edit and most needs to know what they are editing.
 */
export const FieldLabel = ({ className, ...rest }: LabelHTMLAttributes<HTMLLabelElement>) => (
  <label {...rest} className={cn('type-label-mono text-graphite', className)} />
)
