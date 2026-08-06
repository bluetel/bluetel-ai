/**
 * The SC-015 audit, as a function rather than a review habit.
 *
 * SC-015 asks for "zero literal colours, font sizes or radii outside the token set". That is a
 * property of the source, so it is checkable: strip the comments (prose is allowed to say "a 6px
 * square LED"), then look for the three shapes a literal takes in a component — a hex colour, a
 * colour function, and a CSS length.
 *
 * `globals.css` is deliberately not covered: it is the one place the values are allowed to live,
 * and every other layer references them by name.
 */

/** A literal found in a source file, with the 1-based line it sits on. */
export interface DesignLiteral {
  line: number
  value: string
}

/** Hex colours (`#fff`, `#1B4FE0`, `#0B1015CC`). */
const HEX_COLOUR = /#[0-9a-fA-F]{3,8}\b/g

/** Colour functions (`rgb(...)`, `rgba(...)`, `hsl(...)`, `hsla(...)`). */
const COLOUR_FUNCTION = /\b(?:rgba?|hsla?)\s*\(/g

/**
 * CSS lengths (`12px`, `1.5rem`, `0.11em`).
 *
 * `ch` and `vw` are included because a measure and a fluid type ceiling are design values too, and
 * both already have tokens.
 */
const CSS_LENGTH = /(?<![\w-])\d+(?:\.\d+)?(?:px|rem|em|ch|vw|vh)\b/g

/**
 * Remove line and block comments so documentation can quote a value without failing the audit.
 *
 * Replaced with equal-length whitespace rather than deleted, so reported line numbers still match
 * the file the reader opens.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length))

/**
 * Find every design literal in a source file.
 *
 * @param source - File contents, TypeScript or TSX.
 * @returns Every literal found, in source order. Empty means the file is compliant.
 */
export const findDesignLiterals = (source: string): DesignLiteral[] => {
  const stripped = stripComments(source)
  const found: DesignLiteral[] = []

  for (const [index, text] of stripped.split('\n').entries()) {
    for (const pattern of [HEX_COLOUR, COLOUR_FUNCTION, CSS_LENGTH]) {
      for (const match of text.matchAll(pattern)) {
        found.push({ line: index + 1, value: match[0] })
      }
    }
  }

  return found
}
