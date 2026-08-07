import { cn } from '@sisyphus-admin/lib/cn'
import type { ReactNode } from 'react'

interface PanelNoteProps {
  /** What the panel has to say instead of rows. One short line, lower case, no full stop. */
  children: ReactNode
  /**
   * Announced to assistive technology when it appears. `status` for a reading state, because it
   * arrives without the operator doing anything; omitted for a settled one, which is already part
   * of the page they are reading.
   */
  role?: 'status'
  /** `loading` or `empty`. One attribute a test, a stylesheet or a screenshot can read. */
  note: 'loading' | 'empty'
  className?: string
}

/**
 * The one line a panel shows where its rows would be (FR-201).
 *
 * ## Why loading and empty are the same element
 *
 * They are the same line of `data-mono` in `graphite`, in the same place, with the same leading —
 * so a card that says `reading the users` and then says `no users match that search` has not moved
 * anything on the page. Two components drawn differently would put a layout shift in exactly the
 * moment an operator is watching for the answer, and it is free to avoid: the states are mutually
 * exclusive and one of them is always the same height as the other.
 *
 * It is deliberately **not** a spinner. FR-029 rules a spinner out of a button for the reason it is
 * ruled out here — an indeterminate ring says something is happening, which the operator already
 * knew. A card header carries a `reading` chip and the body says what is being read.
 *
 * ## Not exported from the barrel
 *
 * {@link import('./empty-state').EmptyState} and {@link import('./loading-state').LoadingState} are.
 * A screen must say which of the two states it is in, and a general-purpose "note" would be the
 * third way of writing a line the design system already has exactly two meanings for.
 */
export const PanelNote = ({ children, role, note, className }: PanelNoteProps) => (
  <p role={role} data-note={note} className={cn('type-data-mono text-graphite', className)}>
    {children}
  </p>
)
