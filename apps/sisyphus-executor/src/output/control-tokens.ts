/**
 * Terminal control-sequence scanner (T058, FR-045).
 *
 * The scanner's only job is to split a byte stream into printable text and the
 * control tokens a terminal would act on. It deliberately does not decide what
 * the output should look like — `screen-buffer.ts` does that — because the two
 * concerns fail differently: a scanner bug drops characters, a buffer bug puts
 * them in the wrong place.
 *
 * Two properties matter for the streaming caller:
 *
 * - An escape sequence split across a chunk boundary is returned as
 *   `remainder` rather than being emitted as literal text. A stripper that
 *   prints the visible half of a colour sequence because its final byte
 *   landed in the next read has leaked the very bytes it exists to remove.
 * - An unterminated string sequence (OSC and friends) is bounded. Without the
 *   bound, one malformed `]` would swallow the rest of the run.
 */

const ESCAPE = '\u001B'
const BELL = '\u0007'

/** Where an unterminated OSC/DCS/APC sequence stops swallowing the stream. */
const MAX_STRING_SEQUENCE_LENGTH = 4096

/** Parameter bytes, 0x30-0x3f. */
const CSI_PARAMETER = /[\u0030-\u003f]/
/** Intermediate bytes, 0x20-0x2f. */
const CSI_INTERMEDIATE = /[\u0020-\u002f]/
const PRIVATE_CSI_PREFIX = /^[?<>=]/

/** Introducers whose sequence runs until a string terminator rather than a final byte. */
const STRING_INTRODUCERS = new Set([']', 'P', 'X', '^', '_'])

export type ControlToken =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'line-feed' }
  | { readonly kind: 'carriage-return' }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'csi'; readonly finalByte: string; readonly params: readonly number[] }

export interface ControlTokenScan {
  readonly tokens: readonly ControlToken[]
  /**
   * Trailing input that is the start of an escape sequence which has not
   * finished yet. Empty unless `allowIncomplete` was set; the caller prepends
   * it to the next chunk.
   */
  readonly remainder: string
}

export interface ControlTokenScanOptions {
  /**
   * Streaming mode. An incomplete trailing sequence is handed back rather than
   * discarded, so it can be completed by the next chunk.
   */
  readonly allowIncomplete?: boolean
}

const isIntermediate = (character: string): boolean =>
  character !== '' && CSI_INTERMEDIATE.test(character)

/**
 * Length of the CSI sequence starting at `start`, or `undefined` when the
 * input ends before the final byte arrives.
 */
const measureControlSequence = (input: string, start: number): number | undefined => {
  let index = start + 2

  while (index < input.length && CSI_PARAMETER.test(input.charAt(index))) {
    index += 1
  }

  while (index < input.length && CSI_INTERMEDIATE.test(input.charAt(index))) {
    index += 1
  }

  if (index >= input.length) {
    return undefined
  }

  return index - start + 1
}

/**
 * Length of an OSC/DCS/SOS/PM/APC sequence, which ends at BEL or at the string
 * terminator `ESC \`. Returns 2 once the bound is exceeded, so a malformed
 * introducer costs two characters rather than the remainder of the run.
 */
const measureStringSequence = (input: string, start: number): number | undefined => {
  let index = start + 2

  while (index < input.length) {
    if (index - start > MAX_STRING_SEQUENCE_LENGTH) {
      return 2
    }

    const character = input.charAt(index)

    if (character === BELL) {
      return index - start + 1
    }

    if (character === ESCAPE) {
      if (index + 1 >= input.length) {
        return undefined
      }

      if (input.charAt(index + 1) === '\\') {
        return index - start + 2
      }
    }

    index += 1
  }

  return undefined
}

const measureEscape = (input: string, start: number): number | undefined => {
  const introducer = input.charAt(start + 1)

  if (introducer === '') {
    return undefined
  }

  if (introducer === '[') {
    return measureControlSequence(input, start)
  }

  if (STRING_INTRODUCERS.has(introducer)) {
    return measureStringSequence(input, start)
  }

  let index = start + 1

  while (index < input.length && isIntermediate(input.charAt(index))) {
    index += 1
  }

  if (index >= input.length) {
    return undefined
  }

  return index - start + 1
}

const parseParameters = (body: string): readonly number[] => {
  if (body === '') {
    return []
  }

  return body.split(';').map((part) => {
    // Sub-parameters (`38:2:…`) only ever refine colour; the leading value is
    // the one any cursor operation would use.
    const value = Number.parseInt(part.split(':')[0], 10)

    return Number.isNaN(value) ? 0 : value
  })
}

const toControlToken = (input: string, start: number, length: number): ControlToken | undefined => {
  if (input.charAt(start + 1) !== '[') {
    return undefined
  }

  const body = input.slice(start + 2, start + length - 1)

  // Private-mode sequences (`[?25l` and the like) toggle terminal state.
  // They move nothing, so they are dropped rather than interpreted.
  if (PRIVATE_CSI_PREFIX.test(body)) {
    return undefined
  }

  return {
    kind: 'csi',
    finalByte: input.charAt(start + length - 1),
    params: parseParameters(body),
  }
}

/**
 * Split `input` into printable text and the control tokens that act on it.
 *
 * Tab is treated as printable: it carries indentation, which is content. Every
 * other C0 and C1 control character that is not a line feed, carriage return
 * or backspace is dropped, because nothing downstream renders it and several
 * of them are actively hostile in a log viewer.
 */
export const scanControlTokens = (
  input: string,
  options: ControlTokenScanOptions = {},
): ControlTokenScan => {
  const tokens: ControlToken[] = []
  let text = ''
  let index = 0

  const flushText = (): void => {
    if (text !== '') {
      tokens.push({ kind: 'text', value: text })
      text = ''
    }
  }

  while (index < input.length) {
    const character = input.charAt(index)

    if (character === ESCAPE) {
      const length = measureEscape(input, index)

      if (length === undefined) {
        flushText()

        return { tokens, remainder: options.allowIncomplete === true ? input.slice(index) : '' }
      }

      flushText()

      const token = toControlToken(input, index, length)

      if (token !== undefined) {
        tokens.push(token)
      }

      index += length
      continue
    }

    const code = character.charCodeAt(0)

    if (code === 0x0a || code === 0x0b || code === 0x0c) {
      flushText()
      tokens.push({ kind: 'line-feed' })
      index += 1
      continue
    }

    if (code === 0x0d) {
      flushText()
      tokens.push({ kind: 'carriage-return' })
      index += 1
      continue
    }

    if (code === 0x08) {
      flushText()
      tokens.push({ kind: 'backspace' })
      index += 1
      continue
    }

    if (code === 0x09) {
      text += character
      index += 1
      continue
    }

    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      index += 1
      continue
    }

    text += character
    index += 1
  }

  flushText()

  return { tokens, remainder: '' }
}
