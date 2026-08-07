import type { ReactNode } from 'react'

import { PanelNote } from './panel-note'

interface EmptyStateProps {
  /**
   * What is absent, and why that is a fact rather than a failure — `no users match that search`,
   * `nobody has been granted this profile`. Never "no data" and never "nothing here".
   */
  children: ReactNode
  className?: string
}

/**
 * A list with nothing in it, stated (FR-201).
 *
 * A blank region is not an empty state: it is indistinguishable from a query that has not answered,
 * from a filter that removed everything, and from a panel that failed to render. This says which,
 * in the caller's own words, because only the caller knows whether zero rows means "nothing has
 * happened yet" or "nothing matched what you asked for" — and those two sentences send an operator
 * to different places.
 *
 * It carries no `role`. An empty list that is empty on arrival is part of the page a person is
 * reading, not an event to interrupt them with; the transition *into* it is announced by the
 * loading note it replaces.
 */
export const EmptyState = ({ children, className }: EmptyStateProps) => (
  <PanelNote note="empty" className={className}>
    {children}
  </PanelNote>
)
