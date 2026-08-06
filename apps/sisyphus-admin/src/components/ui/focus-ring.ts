/**
 * The focus-ring treatment, as one class every interactive primitive composes in.
 *
 * The rule itself lives in `globals.css` (`2px solid signal` at `2px` offset, on `:focus-visible`)
 * because the width and the offset are token values and belong with the other token values. What
 * this constant buys is that no primitive can quietly ship a different ring: there is one name, and
 * a button, a field and anything focusable added later all reach for it.
 */
export const FOCUS_RING = 'focus-ring'
