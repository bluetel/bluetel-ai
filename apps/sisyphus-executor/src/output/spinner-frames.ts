/**
 * Spinner and progress-frame recognition (T058, FR-045).
 *
 * Carriage-return resolution already collapses a redrawn progress line to its
 * final frame, so what is left here is a single residual glyph: either alone
 * on a line, or leading a line of real text (`⠋ Fetching…`).
 *
 * The set is split on purpose. Braille and the geometric spinner glyphs never
 * appear in real log text, so they can be removed wherever they lead a line.
 * The ASCII spinner characters `|/-\` appear constantly — as table rules, as
 * list bullets, as path separators — so they are only ever treated as a
 * spinner when the line consists of nothing else **and** the line was redrawn
 * in place. Stripping a leading `-` from a Markdown list because it looks like
 * a spinner frame would be a worse bug than the one being fixed.
 */

/* cspell:ignore braille */

const ASCII_SPINNER_GLYPHS = new Set(['|', '/', '-', '\\'])

/** Geometric and arrow spinner frames from the common spinner sets. */
const GEOMETRIC_SPINNER_GLYPHS = new Set(
  Array.from(
    ['◐◓◑◒', '◴◷◶◵', '◰◳◲◱', '▖▘▝▗', '▁▂▃▄▅▆▇', '←↖↑↗→↘↓↙', '✶✸✹✺✷', '●○◍◌◉', '⬒⬔⬓⬕', '∙'].join(''),
  ),
)

const BRAILLE_FIRST_CODE_POINT = 0x2800
const BRAILLE_LAST_CODE_POINT = 0x28ff

const isBrailleGlyph = (character: string): boolean => {
  const code = character.codePointAt(0)

  return code !== undefined && code >= BRAILLE_FIRST_CODE_POINT && code <= BRAILLE_LAST_CODE_POINT
}

/** Glyphs safe to remove from the head of a line of otherwise real content. */
const isDistinctiveSpinnerGlyph = (character: string): boolean =>
  isBrailleGlyph(character) || GEOMETRIC_SPINNER_GLYPHS.has(character)

const isAnySpinnerGlyph = (character: string): boolean =>
  isDistinctiveSpinnerGlyph(character) || ASCII_SPINNER_GLYPHS.has(character)

const LEADING_GLYPH = /^(\s*)(\S)(\s|$)/u

/**
 * Remove a single leading spinner glyph, keeping the indentation and the
 * content behind it. Anything else is returned unchanged.
 */
export const stripLeadingSpinnerGlyph = (text: string): string => {
  const match = LEADING_GLYPH.exec(text)

  if (match === null || !isDistinctiveSpinnerGlyph(match[2])) {
    return text
  }

  return match[1] + text.slice(match[0].length)
}

/**
 * True when the line carries no content beyond spinner glyphs. A blank line is
 * not a spinner: blank lines are meaningful spacing and must survive.
 */
export const isSpinnerOnlyLine = (text: string): boolean => {
  const trimmed = text.trim()

  if (trimmed === '') {
    return false
  }

  return Array.from(trimmed).every((character) => isAnySpinnerGlyph(character))
}
