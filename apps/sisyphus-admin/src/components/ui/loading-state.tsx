import type { ReactNode } from 'react'

import { PanelNote } from './panel-note'

interface LoadingStateProps {
  /**
   * What is being read — `reading the users`, `reading this chain`. Defaults to `reading`, which is
   * the same word the card header's chip uses, so the two never disagree.
   */
  children?: ReactNode
  className?: string
}

/**
 * A query in flight, stated (FR-201).
 *
 * The reason this exists as its own component rather than as an absent element is that **an empty
 * body and an empty list look identical**. Every panel in this console renders its empty case only
 * once the read has settled, which is correct — but it leaves the interval before that showing
 * nothing at all, and nothing at all is the one thing FR-201 forbids a screen to render. So the
 * interval says what it is doing.
 *
 * `role="status"` because it appears without the operator acting, and it is polite rather than
 * assertive because a read finishing is not an alert.
 */
export const LoadingState = ({ children = 'reading', className }: LoadingStateProps) => (
  <PanelNote note="loading" role="status" className={className}>
    {children}
  </PanelNote>
)
