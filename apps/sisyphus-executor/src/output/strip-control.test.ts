import { describe, expect, it } from 'vitest'

import { createControlStripper, stripControlSequences } from './strip-control'

/* cspell:ignore merror Doneloading */

const ESC = String.fromCharCode(0x1b)

/**
 * The shape `git clone` actually writes: two ordinary lines, then a progress
 * line redrawn in place with carriage returns and no line feed until it is
 * finished. This is phase 6 output (`entry_checkout`) verbatim in structure.
 */
const GIT_CLONE_OUTPUT = [
  "Cloning into '/workspace/api'...\n",
  'remote: Enumerating objects: 1200, done.\n',
  'Receiving objects:   1% (12/1200)\r',
  'Receiving objects:  47% (564/1200)\r',
  'Receiving objects: 100% (1200/1200), 4.21 MiB | 3.10 MiB/s, done.\r\n',
  'Resolving deltas: 100% (300/300), done.\n',
].join('')

/**
 * The shape a package manager writes: cursor hidden, a coloured braille
 * spinner redrawn in place, then erase-line plus column-1 before the final
 * result. Phase 5 (`setup_script`) output looks like this.
 */
const PACKAGE_MANAGER_OUTPUT = [
  `${ESC}[?25l`,
  `${ESC}[36m⠋${ESC}[39m Installing dependencies\r`,
  `${ESC}[36m⠙${ESC}[39m Installing dependencies\r`,
  `${ESC}[36m⠹${ESC}[39m Installing dependencies\r`,
  `${ESC}[2K${ESC}[1G`,
  `${ESC}[32m✔${ESC}[39m Installed 412 packages in 3.2s\n`,
  `${ESC}[?25h`,
].join('')

describe('stripControlSequences', () => {
  it('removes colour sequences and keeps the text', () => {
    expect(stripControlSequences(`${ESC}[31merror:${ESC}[0m boom\n`)).toBe('error: boom\n')
  })

  it('collapses a carriage-return redraw to the line the terminal would show', () => {
    expect(stripControlSequences(GIT_CLONE_OUTPUT)).toBe(
      [
        "Cloning into '/workspace/api'...",
        'remote: Enumerating objects: 1200, done.',
        'Receiving objects: 100% (1200/1200), 4.21 MiB | 3.10 MiB/s, done.',
        'Resolving deltas: 100% (300/300), done.',
        '',
      ].join('\n'),
    )
  })

  it('resolves a spinner redraw to its final frame', () => {
    expect(stripControlSequences(PACKAGE_MANAGER_OUTPUT)).toBe('✔ Installed 412 packages in 3.2s\n')
  })

  it('turns three thousand redraw frames into one line', () => {
    let input = ''

    for (let frame = 0; frame <= 3000; frame += 1) {
      input += `Scanning: ${frame}/3000 files\r`
    }

    input += 'Scanning: 3000/3000 files, done.\n'

    const output = stripControlSequences(input)

    expect(output).toBe('Scanning: 3000/3000 files, done.\n')
    expect(output.split('\n')).toHaveLength(2)
  })

  it('leaves the residue a real terminal would leave when the writer does not erase', () => {
    // Not a bug: a short redraw over a long line leaves the tail visible, and
    // reproducing that is the point of replaying rather than deleting bytes.
    expect(stripControlSequences('Downloading 100%\rDone\n')).toBe('Doneloading 100%\n')
  })

  it('honours an erase-line when the writer does erase', () => {
    expect(stripControlSequences(`Downloading 100%\rDone${ESC}[K\n`)).toBe('Done\n')
  })

  it('drops a line left holding nothing but a spinner frame', () => {
    expect(stripControlSequences('⠋\r⠙\r⠹\r')).toBe('')
  })

  it('keeps blank lines, which are content', () => {
    expect(stripControlSequences('one\n\ntwo\n')).toBe('one\n\ntwo\n')
  })

  it('keeps a final line that has no terminator', () => {
    expect(stripControlSequences('no trailing newline')).toBe('no trailing newline')
  })

  it('drops an operating-system command that sets the window title', () => {
    const bell = String.fromCharCode(0x07)

    expect(stripControlSequences(`${ESC}]0;building${bell}building\n`)).toBe('building\n')
  })

  it('preserves ordering across a long mixed run', () => {
    const input = `${GIT_CLONE_OUTPUT}${PACKAGE_MANAGER_OUTPUT}`
    const lines = stripControlSequences(input).split('\n').filter(Boolean)

    expect(lines[0]).toContain('Cloning into')
    expect(lines[lines.length - 1]).toContain('Installed 412 packages')
  })

  it('is empty for empty input', () => {
    expect(stripControlSequences('')).toBe('')
  })
})

describe('createControlStripper', () => {
  const collect = (chunks: readonly string[]): string => {
    const stripper = createControlStripper()

    return chunks.map((chunk) => stripper.push(chunk)).join('') + stripper.flush()
  }

  it('produces the same result however the reads happen to split', () => {
    const input = `${GIT_CLONE_OUTPUT}${PACKAGE_MANAGER_OUTPUT}`
    const expected = stripControlSequences(input)

    for (let split = 1; split < input.length; split += 7) {
      expect(collect([input.slice(0, split), input.slice(split)])).toBe(expected)
    }
  })

  it('does not leak the tail of an escape sequence split across chunks', () => {
    expect(collect([`red ${ESC}[3`, '1m and more\n'])).toBe('red  and more\n')
  })

  it('resolves a redraw that arrives one frame per chunk', () => {
    const frames = ['Step 1/3\r', 'Step 2/3\r', 'Step 3/3\r', 'Step 3/3 complete\n']

    expect(collect(frames)).toBe('Step 3/3 complete\n')
  })

  it('emits settled lines before the stream ends', () => {
    const stripper = createControlStripper({ retainRows: 0 })

    expect(stripper.push('first\nsecond\n')).toBe('first\nsecond\n')
    expect(stripper.flush()).toBe('')
  })

  it('discards an escape sequence that never completes', () => {
    const stripper = createControlStripper()

    expect(stripper.push(`done${ESC}[`)).toBe('')
    expect(stripper.flush()).toBe('done')
  })
})
