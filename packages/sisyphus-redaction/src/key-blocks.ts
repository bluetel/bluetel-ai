/**
 * PEM private-key block removal (T059, FR-045, FR-072).
 *
 * A private key is the one credential a regular expression cannot handle in a
 * stream. It spans many lines, its body is indistinguishable from any other
 * base64, and by the time a batch matcher could see the `-----END` line a
 * streaming redactor has already emitted half the key. So it gets a state
 * machine instead: once a `BEGIN … PRIVATE KEY` header is recognised,
 * everything is dropped until the matching end marker, whatever arrives in
 * between and however it is chunked.
 *
 * `BEGIN CERTIFICATE` and friends are deliberately left alone. A certificate
 * is public, and dropping it would hide exactly the diagnostic detail an
 * operator needs when a bundle's TLS setup goes wrong.
 */

const BEGIN_MARKER = '-----BEGIN'
const END_MARKER = '-----END'

const PRIVATE_KEY_HEADER = /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/

/** A header line longer than this is not a header; stop waiting for one. */
const MAX_HEADER_LENGTH = 256

export const PRIVATE_KEY_PLACEHOLDER = '[redacted:private-key]'

export interface KeyBlockFilter {
  readonly push: (text: string) => string
  readonly flush: () => string
}

type FilterState = 'outside' | 'header' | 'suppressing'

/**
 * Longest prefix of `marker` that is a suffix of `text`. Held back so a marker
 * split across two chunks is still recognised when the rest arrives.
 */
const trailingPartialMarker = (text: string, marker: string): number => {
  const maximum = Math.min(marker.length - 1, text.length)

  for (let length = maximum; length > 0; length -= 1) {
    if (text.endsWith(marker.slice(0, length))) {
      return length
    }
  }

  return 0
}

export const createKeyBlockFilter = (): KeyBlockFilter => {
  let state: FilterState = 'outside'
  /** Text held back because it might be the start of a marker or a header. */
  let held = ''

  const consumeOutside = (): string => {
    const markerAt = held.indexOf(BEGIN_MARKER)

    if (markerAt === -1) {
      const partial = trailingPartialMarker(held, BEGIN_MARKER)
      const output = held.slice(0, held.length - partial)

      held = held.slice(held.length - partial)

      return output
    }

    const output = held.slice(0, markerAt)

    held = held.slice(markerAt)
    state = 'header'

    return output + consumeHeader()
  }

  const consumeHeader = (): string => {
    const lineEnd = held.indexOf('\n')

    if (lineEnd === -1) {
      if (held.length <= MAX_HEADER_LENGTH) {
        return ''
      }

      // Far too long to be a header line. Whatever it is, it is not a key.
      const output = held

      held = ''
      state = 'outside'

      return output
    }

    const line = held.slice(0, lineEnd)

    if (!PRIVATE_KEY_HEADER.test(line)) {
      const output = held.slice(0, lineEnd + 1)

      held = held.slice(lineEnd + 1)
      state = 'outside'

      return output + consumeOutside()
    }

    held = held.slice(lineEnd + 1)
    state = 'suppressing'

    return `${PRIVATE_KEY_PLACEHOLDER}\n${consumeSuppressed()}`
  }

  const consumeSuppressed = (): string => {
    const markerAt = held.indexOf(END_MARKER)

    if (markerAt === -1) {
      // Nothing here may be emitted, so only a partial end marker is kept.
      held = held.slice(held.length - trailingPartialMarker(held, END_MARKER))

      return ''
    }

    const lineEnd = held.indexOf('\n', markerAt)

    if (lineEnd === -1) {
      held = held.slice(markerAt)

      return ''
    }

    held = held.slice(lineEnd + 1)
    state = 'outside'

    return consumeOutside()
  }

  const advance = (): string => {
    switch (state) {
      case 'outside':
        return consumeOutside()
      case 'header':
        return consumeHeader()
      case 'suppressing':
        return consumeSuppressed()
    }
  }

  return {
    push: (text: string): string => {
      held += text

      return advance()
    },

    flush: (): string => {
      const output = advance()

      if (state === 'suppressing') {
        held = ''

        return output
      }

      // A key whose stream ended before its header line was terminated is
      // still a key: emit the placeholder rather than the marker.
      if (state === 'header' && PRIVATE_KEY_HEADER.test(held)) {
        held = ''
        state = 'outside'

        return `${output}${PRIVATE_KEY_PLACEHOLDER}\n`
      }

      const remainder = held

      held = ''
      state = 'outside'

      return output + remainder
    },
  }
}

/** Remove every private-key block from a complete string. */
export const stripPrivateKeyBlocks = (text: string): string => {
  const filter = createKeyBlockFilter()

  return filter.push(text) + filter.flush()
}
