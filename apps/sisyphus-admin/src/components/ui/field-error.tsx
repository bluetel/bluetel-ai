import { cn } from '@sisyphus-admin/lib/cn'

/**
 * What an error must carry (FR-031).
 *
 * Both halves are required, and that is the whole point of the interface. "Invalid input" is not a
 * next action and "Something went wrong" is not a code; a message with neither leaves the operator
 * with nothing to do and nothing to search for. Making both mandatory means the dead-end message
 * cannot be written without deleting a property first.
 */
export interface FieldErrorContent {
  /** The machine code, e.g. `E_PROFILE_NOT_FOUND`. Searchable, stable, and quotable in a ticket. */
  code: string
  /** What to do next, in a sentence. Not a restatement of what failed. */
  action: string
}

interface FieldErrorProps extends FieldErrorContent {
  id?: string
  className?: string
}

/**
 * The help text under a refused field: the code in `label-mono`, the next action in `data-mono`,
 * both in `rust`.
 *
 * `role="alert"` because an error that appears after a submit has to reach a screen reader without
 * the operator going looking for it.
 */
export const FieldError = ({ code, action, id, className }: FieldErrorProps) => (
  <p id={id} role="alert" className={cn('type-data-mono text-rust', className)}>
    <span className="type-label-mono">{code}</span> {action}
  </p>
)
