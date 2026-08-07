import { describe, expect, it } from 'vitest'

import { extractProposal, PROPOSAL_TAG, proposalMarkers, stripCodeFence } from './proposal-block'

const NONCE = '7c9f0a1e'

const blockFor = (nonce: string, body: string): string => {
  const { open, close } = proposalMarkers(nonce)

  return `${open}\n${body}\n${close}`
}

describe('proposalMarkers', () => {
  it('carries the nonce on both markers so a block belongs to one request', () => {
    const markers = proposalMarkers(NONCE)

    expect(markers.open).toContain(NONCE)
    expect(markers.close).toContain(NONCE)
    expect(markers.open).toContain(PROPOSAL_TAG)
  })

  it('does not make the closing marker a prefix or suffix of the opening one', () => {
    const { open, close } = proposalMarkers(NONCE)

    // A truncated open must never read as a complete close, in either direction.
    expect(open.startsWith(close)).toBe(false)
    expect(close.startsWith(open)).toBe(false)
    expect(open.endsWith(close)).toBe(false)
  })
})

describe('extractProposal', () => {
  it('reads the JSON object out of a complete block', () => {
    const transcript = `working on it\n${blockFor(NONCE, '{"wasChanged": true}')}\ndone`

    expect(extractProposal(transcript, NONCE)).toEqual({
      kind: 'found',
      value: { wasChanged: true },
    })
  })

  it('reports absent when the agent has not opened a block yet', () => {
    expect(extractProposal('thinking about the ticket', NONCE)).toEqual({ kind: 'absent' })
  })

  it('reports absent for an empty transcript', () => {
    expect(extractProposal('', NONCE)).toEqual({ kind: 'absent' })
  })

  it('reports truncated when the block was opened and never closed', () => {
    const { open } = proposalMarkers(NONCE)

    expect(extractProposal(`${open}\n{"wasChanged": tr`, NONCE)).toEqual({ kind: 'truncated' })
  })

  it('reports truncated when a closing marker arrives with nothing opening it', () => {
    const { close } = proposalMarkers(NONCE)

    // Reading from the start of the transcript here would mean parsing whatever prose preceded
    // the marker, which is exactly the guess this module exists to refuse.
    expect(extractProposal(`some prose\n{"wasChanged": true}\n${close}`, NONCE)).toEqual({
      kind: 'truncated',
    })
  })

  it('reports malformed when a complete block does not contain JSON', () => {
    const extraction = extractProposal(
      blockFor(NONCE, 'I could not work out the conventions'),
      NONCE,
    )

    expect(extraction.kind).toBe('malformed')
    expect(extraction.kind === 'malformed' && extraction.detail).toContain('not JSON')
  })

  it('reports malformed when the block contains JSON that is not an object', () => {
    const extraction = extractProposal(blockFor(NONCE, '["branchName"]'), NONCE)

    expect(extraction.kind).toBe('malformed')
    expect(extraction.kind === 'malformed' && extraction.detail).toContain('array')
  })

  it('ignores a block carrying a different request’s nonce', () => {
    // The autonomous loop's second pass, with the first pass's answer still in the transcript.
    const transcript = blockFor('first-pass-nonce', '{"wasChanged": true}')

    expect(extractProposal(transcript, 'second-pass-nonce')).toEqual({ kind: 'absent' })
  })

  it('takes the last complete block when the agent restated the format first', () => {
    const transcript = [
      'the format I was asked for is',
      blockFor(NONCE, '{"note": "an illustration"}'),
      'and here is the real answer',
      blockFor(NONCE, '{"note": "the answer"}'),
    ].join('\n')

    expect(extractProposal(transcript, NONCE)).toEqual({
      kind: 'found',
      value: { note: 'the answer' },
    })
  })

  it('is still satisfied by an earlier complete block when a later one is cut off', () => {
    const { open } = proposalMarkers(NONCE)
    const transcript = `${blockFor(NONCE, '{"note": "complete"}')}\n${open}\n{"note": "cut`

    expect(extractProposal(transcript, NONCE)).toEqual({
      kind: 'found',
      value: { note: 'complete' },
    })
  })

  it('prefers the answer over the example the instruction showed it', () => {
    // What the turn itself contains: the markers around a line describing the shape. An agent
    // that quotes its instructions back must not thereby look like an agent that answered.
    const transcript = [
      blockFor(NONCE, '{ ... a single JSON object ... }'),
      'here is the actual answer',
      blockFor(NONCE, '{"note": "the answer"}'),
      'and that is the format I was given:',
      blockFor(NONCE, '{ ... a single JSON object ... }'),
    ].join('\n')

    expect(extractProposal(transcript, NONCE)).toEqual({
      kind: 'found',
      value: { note: 'the answer' },
    })
  })

  it('reports malformed only when no complete block is readable', () => {
    const transcript = [
      blockFor(NONCE, 'I could not work out the conventions'),
      blockFor(NONCE, 'nor on a second attempt'),
    ].join('\n')

    expect(extractProposal(transcript, NONCE)).toMatchObject({ kind: 'malformed' })
  })

  it('reads a block whose body the agent wrapped in a code fence', () => {
    const transcript = blockFor(NONCE, '```json\n{"wasChanged": false}\n```')

    expect(extractProposal(transcript, NONCE)).toEqual({
      kind: 'found',
      value: { wasChanged: false },
    })
  })

  it('reads a block reassembled from the chunks it arrived in', () => {
    // What the port accumulates: one block delivered as several assistant frames, with the
    // markers themselves split across a frame boundary.
    const whole = blockFor(NONCE, '{"wasChanged": true}')
    const transcript = [whole.slice(0, 12), whole.slice(12, 30), whole.slice(30)].join('')

    expect(extractProposal(transcript, NONCE)).toEqual({
      kind: 'found',
      value: { wasChanged: true },
    })
  })
})

describe('stripCodeFence', () => {
  it('removes a fence with a language tag', () => {
    expect(stripCodeFence('```json\n{"a": 1}\n```')).toBe('{"a": 1}')
  })

  it('removes a fence with no language tag', () => {
    expect(stripCodeFence('```\n{"a": 1}\n```')).toBe('{"a": 1}')
  })

  it('leaves unfenced text alone apart from surrounding whitespace', () => {
    expect(stripCodeFence('\n  {"a": 1}  \n')).toBe('{"a": 1}')
  })

  it('leaves a single-line string starting and ending in backticks alone', () => {
    expect(stripCodeFence('``` not really a fence ```')).toBe('``` not really a fence ```')
  })
})
