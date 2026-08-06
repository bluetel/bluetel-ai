import { describe, expect, it } from 'vitest'

import { createSanitiser, sanitise, sanitisedByteLength } from './sanitise'

/* cspell:ignore mfetching */

const ESC = String.fromCharCode(0x1b)

/** Synthetic. Not a credential belonging to anything. */
const AGENT_VALUE = 'not-a-real-agent-credential-0123456789'

describe('sanitise', () => {
  it('strips control sequences and redacts in one pass', () => {
    const input = `${ESC}[31musing ${AGENT_VALUE}${ESC}[0m\n`

    expect(sanitise(input, { secrets: [{ name: 'agent-credential', value: AGENT_VALUE }] })).toBe(
      'using [redacted:agent-credential]\n',
    )
  })

  it('strips before redacting, so a sequence inside a value cannot hide it', () => {
    const split = `${AGENT_VALUE.slice(0, 10)}${ESC}[0m${AGENT_VALUE.slice(10)}`

    expect(
      sanitise(`${split}\n`, { secrets: [{ name: 'agent-credential', value: AGENT_VALUE }] }),
    ).toBe('[redacted:agent-credential]\n')
  })

  it('resolves a carriage-return redraw before anything else sees it', () => {
    expect(sanitise('Step 1\rStep 2\rStep 3 done\n')).toBe('Step 3 done\n')
  })

  it('is empty for empty input', () => {
    expect(sanitise('')).toBe('')
  })
})

describe('createSanitiser', () => {
  it('produces the same result however the reads split', () => {
    const secrets = [{ name: 'agent-credential', value: AGENT_VALUE }]
    const input = `${ESC}[36mfetching${ESC}[39m\ntoken=${AGENT_VALUE}\ndone\n`
    const expected = sanitise(input, { secrets })

    for (let split = 1; split < input.length; split += 1) {
      const sanitiser = createSanitiser({ secrets })
      const output = sanitiser.push(input.slice(0, split)) + sanitiser.push(input.slice(split))

      expect(output + sanitiser.flush()).toBe(expected)
    }
  })

  it('never releases a secret split across a read boundary', () => {
    const secrets = [{ name: 'agent-credential', value: AGENT_VALUE }]
    const input = `token=${AGENT_VALUE}\n`

    for (let split = 1; split < input.length; split += 1) {
      const sanitiser = createSanitiser({ secrets })
      const released = [
        sanitiser.push(input.slice(0, split)),
        sanitiser.push(input.slice(split)),
        sanitiser.flush(),
      ]

      for (const piece of released) {
        expect(piece).not.toContain(AGENT_VALUE)
      }
    }
  })
})

describe('sanitisedByteLength', () => {
  it('counts bytes rather than code units', () => {
    expect(sanitisedByteLength(sanitise('abc'))).toBe(3)
    expect(sanitisedByteLength(sanitise('é'))).toBe(2)
    expect(sanitisedByteLength(sanitise('😀'))).toBe(4)
  })
})
