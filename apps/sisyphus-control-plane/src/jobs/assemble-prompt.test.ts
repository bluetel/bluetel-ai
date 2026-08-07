import type { PromptParts } from '@bluetel-ai/sisyphus-api/contracts'
import { describe, expect, it } from 'vitest'

import {
  assembleIntegrationPrompt,
  assemblePrompt,
  hasNoTask,
  NO_DESCRIPTION,
  PROMPT_SECTIONS,
  TRUNCATION_NOTICE,
} from './assemble-prompt'
import type { PromptRedactor, RedactedPromptParts } from './prompt-redact'

/* cspell:ignore AKIA AKIAFIXTUREONLY */

const passThrough: PromptRedactor = { redact: (text) => text }

const ticketOf = (overrides: Partial<RedactedPromptParts> = {}): RedactedPromptParts => ({
  title: 'Checkout totals are wrong for multi-currency baskets',
  url: 'https://example.invalid/browse/FIX-1',
  body: 'The basket adds VAT twice when the currency is not GBP.',
  comments: [],
  truncatedComments: 0,
  ...overrides,
})

const partsOf = (overrides: Partial<PromptParts> = {}): PromptParts => ({
  title: 'Checkout totals are wrong for multi-currency baskets',
  url: 'https://example.invalid/browse/FIX-1',
  body: 'The basket adds VAT twice when the currency is not GBP.',
  comments: [],
  truncatedComments: 0,
  ...overrides,
})

const positionsOf = (prompt: string, ...needles: readonly string[]): readonly number[] =>
  needles.map((needle) => prompt.indexOf(needle))

const isAscending = (values: readonly number[]): boolean =>
  values.every((value, index) => value >= 0 && (index === 0 ? true : value > values[index - 1]))

describe('assemblePrompt layer order (FR-159)', () => {
  const prompt = assemblePrompt({
    preamble: 'The contract lives in packages/contracts.',
    intro: 'Work from this board is delivered as a single pull request.',
    ticket: ticketOf({ comments: ['first comment', 'second comment'] }),
  })

  it('puts the preamble, then the intro, then the ticket', () => {
    expect(
      isAscending(
        positionsOf(prompt, PROMPT_SECTIONS.preamble, PROMPT_SECTIONS.intro, PROMPT_SECTIONS.task),
      ),
    ).toBe(true)
  })

  it('puts title, URL, description and comments in that order within the task', () => {
    expect(
      isAscending(
        positionsOf(
          prompt,
          PROMPT_SECTIONS.title,
          PROMPT_SECTIONS.url,
          PROMPT_SECTIONS.body,
          PROMPT_SECTIONS.comments,
        ),
      ),
    ).toBe(true)
  })

  it('keeps comments oldest first', () => {
    expect(isAscending(positionsOf(prompt, 'first comment', 'second comment'))).toBe(true)
  })

  it('is identical across runs for identical input, so a diff means the ticket changed', () => {
    const again = assemblePrompt({
      preamble: 'The contract lives in packages/contracts.',
      intro: 'Work from this board is delivered as a single pull request.',
      ticket: ticketOf({ comments: ['first comment', 'second comment'] }),
    })

    expect(again).toBe(prompt)
  })

  it('delimits every layer, so standing context is distinguishable from ticket content', () => {
    for (const heading of [PROMPT_SECTIONS.preamble, PROMPT_SECTIONS.intro, PROMPT_SECTIONS.task]) {
      expect(prompt).toContain(`## ${heading}`)
    }
  })
})

describe('assemblePrompt layers that may be absent', () => {
  it('omits the preamble layer entirely when the profile carries none (FR-157)', () => {
    const prompt = assemblePrompt({ intro: 'Board intro.', ticket: ticketOf() })

    expect(prompt).not.toContain(PROMPT_SECTIONS.preamble)
    expect(prompt).toContain(PROMPT_SECTIONS.intro)
  })

  it('treats a whitespace-only preamble as absent rather than as an empty heading', () => {
    expect(assemblePrompt({ preamble: '   \n ', intro: 'Board intro.' })).not.toContain(
      PROMPT_SECTIONS.preamble,
    )
  })

  it('says the ticket has no description rather than leaving a blank section (FR-160)', () => {
    expect(assemblePrompt({ intro: 'Board intro.', ticket: ticketOf({ body: null }) })).toContain(
      NO_DESCRIPTION,
    )
  })

  it('omits the comments section when there are none and none were dropped', () => {
    expect(assemblePrompt({ intro: 'Board intro.', ticket: ticketOf() })).not.toContain(
      PROMPT_SECTIONS.comments,
    )
  })

  it('refuses to assemble without the middle layer (FR-158, FR-165)', () => {
    expect(() => assemblePrompt({ intro: '  ', ticket: ticketOf() })).toThrow(/prompt intro/)
  })

  it('assembles a manually-started prompt, where the engineer occupies the middle layer (FR-165)', () => {
    const prompt = assemblePrompt({
      preamble: 'The contract lives in packages/contracts.',
      intro: 'Add a currency selector to the basket page.',
    })

    expect(prompt).toContain('Add a currency selector')
    expect(prompt).toContain(PROMPT_SECTIONS.preamble)
    expect(prompt).not.toContain(PROMPT_SECTIONS.task)
  })
})

describe('assemblePrompt states what it left out (FR-163)', () => {
  it('names the number of dropped comments in the prompt itself', () => {
    const prompt = assemblePrompt({
      intro: 'Board intro.',
      ticket: ticketOf({ comments: ['newest'], truncatedComments: 4 }),
    })

    expect(prompt).toContain(TRUNCATION_NOTICE(4))
  })

  it('puts the notice before the comments it stands in for, since drops are oldest-first', () => {
    const prompt = assemblePrompt({
      intro: 'Board intro.',
      ticket: ticketOf({ comments: ['newest'], truncatedComments: 2 }),
    })

    expect(isAscending(positionsOf(prompt, TRUNCATION_NOTICE(2), 'newest'))).toBe(true)
  })

  it('renders the notice even when every comment was dropped', () => {
    expect(
      assemblePrompt({ intro: 'Board intro.', ticket: ticketOf({ truncatedComments: 3 }) }),
    ).toContain(TRUNCATION_NOTICE(3))
  })

  it('reads as singular for one dropped comment', () => {
    expect(TRUNCATION_NOTICE(1)).toContain('1 older comment omitted')
  })
})

describe('assembleIntegrationPrompt redacts before it stores (T116, FR-162, FR-163)', () => {
  const redactor: PromptRedactor = {
    redact: (text) => text.replace(/\bAKIA[A-Z0-9]{16}\b/g, '[redacted:access-key-id]'),
  }

  it('stores no credential that the redactor recognises', () => {
    const result = assembleIntegrationPrompt({
      intro: 'Board intro.',
      parts: partsOf({ body: 'Fails with AKIAFIXTUREONLY00000 in the logs.' }),
      redactor,
    })

    expect(result.prompt).not.toContain('AKIAFIXTUREONLY00000')
    expect(result.prompt).toContain('[redacted:access-key-id]')
  })

  it('reports truncation so the workflow row can record it', () => {
    const result = assembleIntegrationPrompt({
      intro: 'Board intro.',
      parts: partsOf({ comments: ['aaaa', 'bbbb'], truncatedComments: 1 }),
      redactor: passThrough,
      maxCharacters: 4,
    })

    expect(result.truncated).toBe(true)
    expect(result.truncatedComments).toBe(2)
    expect(result.prompt).toContain(TRUNCATION_NOTICE(2))
  })

  it('reports no truncation when everything fitted', () => {
    const result = assembleIntegrationPrompt({
      intro: 'Board intro.',
      parts: partsOf({ comments: ['short'] }),
      redactor: passThrough,
    })

    expect(result.truncated).toBe(false)
    expect(result.truncatedComments).toBe(0)
  })

  it('prepends the profile preamble to an integration-started run as well (FR-157)', () => {
    const result = assembleIntegrationPrompt({
      preamble: 'Conventions live in AGENTS.md.',
      intro: 'Board intro.',
      parts: partsOf(),
      redactor: passThrough,
    })

    expect(isAscending(positionsOf(result.prompt, 'Conventions live in', 'Board intro.'))).toBe(
      true,
    )
  })

  it('propagates a refusing redactor rather than assembling an unredacted prompt', () => {
    expect(() =>
      assembleIntegrationPrompt({
        intro: 'Board intro.',
        parts: partsOf(),
        redactor: {
          redact: () => {
            throw new Error('no redactor wired')
          },
        },
      }),
    ).toThrow('no redactor wired')
  })
})

describe('hasNoTask (FR-164)', () => {
  it('is true when title and description are both empty', () => {
    expect(hasNoTask({ title: '   ', body: null })).toBe(true)
  })

  it('is false when there is a title', () => {
    expect(hasNoTask({ title: 'Fix the basket', body: null })).toBe(false)
  })

  it('is false when there is a description', () => {
    expect(hasNoTask({ title: '', body: 'The basket adds VAT twice.' })).toBe(false)
  })

  it('does not count comments as a task', () => {
    // A ticket that is only a comment thread has no statement of what is wanted.
    expect(hasNoTask({ title: '', body: '   ' })).toBe(true)
  })
})
