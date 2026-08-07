/**
 * Control-sequence stripping (T058, FR-045).
 *
 * Stage one of the output pipeline. Everything an agent or a `setup.sh` writes
 * passes through here before it is redacted, segmented, persisted or
 * transmitted.
 *
 * What "stripping" means here is not deletion of escape bytes. It is replay:
 * the tokens are applied to a screen model and the model's settled state is
 * emitted, which is the only interpretation that produces what a human
 * watching the terminal actually saw. The difference shows up on the case that
 * matters — a progress line redrawn with `\r`. Deleting escape bytes leaves
 * every intermediate frame on its own line; replaying leaves one.
 *
 * Streaming is line-oriented on purpose. A carriage return never crosses a
 * line feed, so holding a line until it is complete makes redraw resolution
 * exact regardless of how the reads happen to split. Cursor movement *between*
 * lines is resolved only within the retained window (`retainRows`); beyond it
 * the movement is dropped and the text kept, which is the safe direction to
 * fail — content survives, presentation does not.
 */

import { scanControlTokens } from './control-tokens'
import type { RenderedRow } from './screen-buffer'
import { createScreenBuffer } from './screen-buffer'
import { isSpinnerOnlyLine, stripLeadingSpinnerGlyph } from './spinner-frames'

/**
 * Rows held back from emission so a later cursor-up can still revisit them.
 *
 * A trade-off against FR-046's near-real-time streaming: every retained row is
 * a row the panel has not seen yet. Four covers the multi-line redraws agents
 * actually produce without adding meaningful latency.
 */
export const DEFAULT_RETAINED_ROWS = 4

export interface ControlStripperOptions {
  readonly retainRows?: number
}

export interface ControlStripper {
  /** Feed a chunk; returns the complete lines that have settled. */
  readonly push: (chunk: string) => string
  /** Emit everything still held, including a final line with no terminator. */
  readonly flush: () => string
}

/**
 * Clean one settled row. `undefined` means the row is a spinner frame and
 * should not be emitted at all — emitting it as a blank line would leave the
 * log padded with the noise this stage exists to remove.
 */
const cleanRow = (row: RenderedRow): string | undefined => {
  if (row.text === '') {
    return ''
  }

  if (row.redrawn && isSpinnerOnlyLine(row.text)) {
    return undefined
  }

  const cleaned = stripLeadingSpinnerGlyph(row.text)

  if (cleaned.trim() === '' && row.text.trim() !== '') {
    return undefined
  }

  return cleaned
}

const renderTerminatedRows = (rows: readonly RenderedRow[]): string => {
  let output = ''

  for (const row of rows) {
    const cleaned = cleanRow(row)

    if (cleaned !== undefined) {
      output += `${cleaned}\n`
    }
  }

  return output
}

export const createControlStripper = (options: ControlStripperOptions = {}): ControlStripper => {
  const retainRows = options.retainRows ?? DEFAULT_RETAINED_ROWS
  const buffer = createScreenBuffer()
  let carry = ''

  return {
    push: (chunk: string): string => {
      const scan = scanControlTokens(carry + chunk, { allowIncomplete: true })

      carry = scan.remainder

      for (const token of scan.tokens) {
        buffer.apply(token)
      }

      return renderTerminatedRows(buffer.takeSettledRows(retainRows))
    },

    flush: (): string => {
      if (carry !== '') {
        // An escape sequence that never completed. Its bytes are discarded
        // rather than emitted: half a sequence is still control noise.
        for (const token of scanControlTokens(carry).tokens) {
          buffer.apply(token)
        }

        carry = ''
      }

      const rows = buffer.takeRemainingRows()
      const output = renderTerminatedRows(rows.slice(0, -1))
      const last = rows.length > 0 ? cleanRow(rows[rows.length - 1]) : undefined

      return output + (last ?? '')
    },
  }
}

/**
 * Strip a complete string in one pass. Identical in behaviour to feeding the
 * same string to a `ControlStripper` and flushing.
 */
export const stripControlSequences = (input: string): string => {
  const stripper = createControlStripper()

  return stripper.push(input) + stripper.flush()
}
