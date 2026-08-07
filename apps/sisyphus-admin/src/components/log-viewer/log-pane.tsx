import { StateChip } from '@sisyphus-admin/components/ui'
import type { ReactNode } from 'react'

import type { LogStreamStatus } from './log-stream-events'

/**
 * The pane the log is set in — DESIGN.md's `log-viewer` component, exactly as declared: `paper-2`
 * on `ink`, the `code` token, `rounded-md`, `close` padding. Nothing here restates a value; every
 * class resolves through the Tailwind theme to a CSS variable in `globals.css` (SC-015).
 *
 * It is a **pure** component, taking its lines and its status as props, so the whole of the
 * viewer's rendering can be asserted with `renderToStaticMarkup` — there is no testing library in
 * this repository, and a presentation layer that could only be exercised through a live
 * `EventSource` and a `QueryClient` would in practice not be exercised at all.
 *
 * ## Why the connection state is shown at all
 *
 * A live log that has quietly stopped arriving looks exactly like an agent that has gone quiet,
 * and spike S3's whole finding was that a broken transport can be silent. So the pane always says
 * which of the two it is, in a state chip, using the same vocabulary the rest of the console uses
 * for machine state.
 */

/** Readouts, in the console's uppercase-mono register. */
const STATUS_READOUT: Readonly<Record<LogStreamStatus, string>> = {
  connecting: 'connecting',
  live: 'live',
  interrupted: 'reconnecting',
  complete: 'complete',
  gone: 'ended',
}

interface LogPaneProps {
  readonly status: LogStreamStatus
  /** Sequences known to be missing below the high-water mark, if any. */
  readonly missing?: readonly number[]
  /** How many segments are held in total, when more are held than are shown. */
  readonly total?: number
  /** The rendered lines. Absent when the run has produced nothing yet. */
  readonly children?: ReactNode
}

export const LogPane = ({ status, missing = [], total, children }: LogPaneProps) => {
  const shownCount = total ?? 0

  return (
    <section aria-label="Run output" className="gap-tight flex flex-col">
      <header className="gap-close flex items-center justify-between">
        <span className="type-label-mono text-graphite">run output</span>
        <StateChip>{STATUS_READOUT[status]}</StateChip>
      </header>

      {missing.length > 0 ? (
        // Said out loud rather than rendered as an unexplained jump in the gutter. FR-046 asks for
        // one continuous log; a hole that is not named reads as the agent having paused.
        <p className="type-data-mono text-amber">
          {`Waiting on ${String(missing.length)} segment${missing.length === 1 ? '' : 's'} not yet received.`}
        </p>
      ) : null}

      <div
        // `aria-live` off by design: a log that announced every segment would make the console
        // unusable with a screen reader. It is a region a reader visits, not a notification.
        className="bg-paper-2 text-ink p-close gap-hair flex max-h-screen flex-col overflow-y-auto rounded-md"
      >
        {shownCount === 0 ? (
          <p className="type-code text-graphite italic">No output yet.</p>
        ) : (
          children
        )}
      </div>
    </section>
  )
}
