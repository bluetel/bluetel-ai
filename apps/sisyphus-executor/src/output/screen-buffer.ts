/**
 * A minimal terminal screen model (T058, FR-045).
 *
 * This is the part of control-sequence stripping that naive implementations
 * get wrong. An agent that redraws a progress line with a carriage return
 * writes one line thousands of times; a stripper that merely deletes the
 * escape bytes and keeps every frame turns a three-line log into three
 * thousand. The only meaningful state of such a line is its last one, so the
 * tokens are replayed against a cell buffer and the buffer's final contents
 * are what gets emitted — exactly what a terminal would have shown.
 *
 * The model is deliberately unbounded in rows and bounded in everything else.
 * Rows grow with the input (dropping them would lose log lines), while cursor
 * movements are clamped so a single hostile `1000000B` cannot allocate.
 */

import type { ControlToken } from './control-tokens'

/** Widest line the model will track. Beyond this, writes are discarded. */
const MAX_COLUMNS = 8192

/** Largest single cursor movement. A redraw never needs more; a fuzz test does. */
const MAX_CURSOR_MOVE = 512

export interface RenderedRow {
  /** The row as a terminal would show it, with trailing blanks removed. */
  readonly text: string
  /**
   * True when the cursor moved back over this row — a carriage return, a
   * backspace, or an erase. It is the signal that the row is a redraw frame
   * rather than a line the agent meant to write once.
   */
  readonly redrawn: boolean
}

export interface ScreenBuffer {
  readonly apply: (token: ControlToken) => void
  /**
   * Rows the cursor can no longer reach, removed from the buffer. `retainRows`
   * trailing rows are held back so a later cursor-up can still revisit them.
   */
  readonly takeSettledRows: (retainRows: number) => readonly RenderedRow[]
  /** Everything left, including the row the cursor is on. Resets the buffer. */
  readonly takeRemainingRows: () => readonly RenderedRow[]
}

interface Row {
  /** `undefined` is a cell never written or since erased. */
  cells: (string | undefined)[]
  redrawn: boolean
}

const createRow = (): Row => ({ cells: [], redrawn: false })

const renderRow = (row: Row): RenderedRow => ({
  text: row.cells
    .map((cell) => cell ?? ' ')
    .join('')
    .trimEnd(),
  redrawn: row.redrawn,
})

const clampMove = (value: number): number => Math.min(Math.max(value, 0), MAX_CURSOR_MOVE)

export const createScreenBuffer = (): ScreenBuffer => {
  let rows: Row[] = [createRow()]
  let rowIndex = 0
  let column = 0

  const currentRow = (): Row => rows[rowIndex]

  const markRedrawn = (): void => {
    currentRow().redrawn = true
  }

  const ensureRow = (index: number): void => {
    while (rows.length <= index) {
      rows.push(createRow())
    }
  }

  const writeText = (value: string): void => {
    for (const character of value) {
      if (column >= MAX_COLUMNS) {
        return
      }

      const row = currentRow()

      while (row.cells.length < column) {
        row.cells.push(undefined)
      }

      if (column < row.cells.length) {
        // Overwriting a cell that already held something is a redraw.
        row.redrawn = true
      }

      row.cells[column] = character
      column += 1
    }
  }

  const eraseCells = (row: Row, from: number, to: number): void => {
    for (let index = from; index < Math.min(to, row.cells.length); index += 1) {
      row.cells[index] = undefined
    }
  }

  const applyEraseLine = (mode: number): void => {
    const row = currentRow()

    if (mode === 1) {
      eraseCells(row, 0, column + 1)
    } else if (mode === 2) {
      row.cells = []
    } else {
      row.cells = row.cells.slice(0, column)
    }

    row.redrawn = true
  }

  const applyEraseDisplay = (mode: number): void => {
    if (mode === 0) {
      rows = rows.slice(0, rowIndex + 1)
      applyEraseLine(0)

      return
    }

    if (mode === 1) {
      for (let index = 0; index < rowIndex; index += 1) {
        rows[index].cells = []
        rows[index].redrawn = true
      }

      applyEraseLine(1)

      return
    }

    rows = [createRow()]
    rowIndex = 0
    column = 0
    rows[0].redrawn = true
  }

  const moveToRow = (target: number): void => {
    const clamped = Math.max(target, 0)

    ensureRow(clamped)
    rowIndex = clamped
  }

  const setColumn = (target: number): void => {
    const clamped = Math.min(Math.max(target, 0), MAX_COLUMNS)

    if (clamped < column) {
      markRedrawn()
    }

    column = clamped
  }

  const applyControlSequence = (finalByte: string, params: readonly number[]): void => {
    const arg = (index: number, fallback: number): number =>
      index < params.length ? params[index] : fallback

    switch (finalByte) {
      case 'A':
        moveToRow(rowIndex - clampMove(arg(0, 1)))
        break
      case 'B':
        moveToRow(rowIndex + clampMove(arg(0, 1)))
        break
      case 'C':
        column = Math.min(column + clampMove(arg(0, 1)), MAX_COLUMNS)
        break
      case 'D':
        setColumn(column - clampMove(arg(0, 1)))
        break
      case 'E':
        moveToRow(rowIndex + clampMove(arg(0, 1)))
        column = 0
        break
      case 'F':
        moveToRow(rowIndex - clampMove(arg(0, 1)))
        setColumn(0)
        break
      case 'G':
      case '`':
        setColumn(arg(0, 1) - 1)
        break
      case 'd':
        moveToRow(Math.min(arg(0, 1) - 1, rows.length - 1))
        break
      case 'H':
      case 'f':
        moveToRow(Math.min(arg(0, 1) - 1, rows.length - 1))
        setColumn(arg(1, 1) - 1)
        break
      case 'J':
        applyEraseDisplay(arg(0, 0))
        break
      case 'K':
        applyEraseLine(arg(0, 0))
        break
      case 'X':
        eraseCells(currentRow(), column, column + clampMove(arg(0, 1)))
        markRedrawn()
        break
      case 'P':
        currentRow().cells.splice(column, clampMove(arg(0, 1)))
        markRedrawn()
        break
      case '@':
        currentRow().cells.splice(
          column,
          0,
          ...Array<undefined>(clampMove(arg(0, 1))).fill(undefined),
        )
        markRedrawn()
        break
      default:
        // Colour, mode changes, scrolling regions, device queries: all
        // presentation, none of it content. Dropped.
        break
    }
  }

  return {
    apply: (token: ControlToken): void => {
      switch (token.kind) {
        case 'text':
          writeText(token.value)
          break
        case 'line-feed':
          moveToRow(rowIndex + 1)
          column = 0
          break
        case 'carriage-return':
          if (column > 0) {
            markRedrawn()
          }

          column = 0
          break
        case 'backspace':
          setColumn(column - 1)
          break
        case 'csi':
          applyControlSequence(token.finalByte, token.params)
          break
      }
    },

    takeSettledRows: (retainRows: number): readonly RenderedRow[] => {
      const limit = Math.max(0, Math.min(rowIndex, rows.length - Math.max(retainRows, 0)))
      const settled = rows.splice(0, limit)

      rowIndex -= limit

      return settled.map(renderRow)
    },

    takeRemainingRows: (): readonly RenderedRow[] => {
      const remaining = rows.map(renderRow)

      rows = [createRow()]
      rowIndex = 0
      column = 0

      return remaining
    },
  }
}
