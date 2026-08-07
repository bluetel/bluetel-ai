import { cn } from '@sisyphus-admin/lib/cn'

/**
 * One segment of run output.
 *
 * ## Text, never markup
 *
 * The content is placed as a **child** of `<code>`, so React renders it as a text node. There is no
 * `dangerouslySetInnerHTML` here and there must never be one: run output routinely contains angle
 * brackets, ANSI leftovers and quoted HTML, and the whole point of a log viewer is to show what
 * was produced rather than to interpret it.
 *
 * It is equally deliberate that nothing is **re-sanitised**. Segments are stripped and redacted on
 * the instance before they are persisted (FR-019, FR-045, FR-072) — an unsanitised copy never
 * exists at rest — so a second pass here would be a weaker implementation of a rule already
 * applied, and its first act would be to disagree with the stored record.
 *
 * `whitespace-pre-wrap` because the agent's own line breaks and indentation are information, and
 * `break-words` so a long token wraps inside the pane rather than making the whole log scroll
 * sideways.
 */

/** What is known about a segment's stored text at the moment it is rendered. */
export type LogLineState = 'loading' | 'read' | 'unavailable' | 'too-large'

interface LogLineProps {
  readonly sequence: number
  /** The stored output. Only meaningful when `state` is `read`. */
  readonly text?: string
  readonly state: LogLineState
}

const PLACEHOLDER: Readonly<Record<Exclude<LogLineState, 'read'>, string>> = {
  loading: 'Reading…',
  // Named as retention rather than as an error: a segment whose object has aged out is a gap in
  // the record with a reason, and saying "failed" would invite someone to retry it forever.
  unavailable: 'This segment is no longer stored.',
  'too-large': 'This segment is too large to display here.',
}

export const LogLine = ({ sequence, text, state }: LogLineProps) => (
  <div className="gap-close flex items-start" data-sequence={sequence}>
    <span
      aria-hidden="true"
      className="type-data-mono text-graphite shrink-0 select-none tabular-nums"
    >
      {sequence}
    </span>
    <code
      className={cn(
        'type-code min-w-0 flex-1 whitespace-pre-wrap break-words',
        state === 'read' ? 'text-ink' : 'text-graphite italic',
      )}
    >
      {state === 'read' ? text : PLACEHOLDER[state]}
    </code>
  </div>
)
