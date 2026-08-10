/**
 * T196 — reading a review out of a block, and the two things it refuses to do quietly.
 *
 * The assertions worth the space are the refusals. A finding whose severity is a word the agent
 * invented must not be filed as an `info`, and a finding with no summary must not be dropped: both
 * are a blocker lost, and a blocker lost is the most expensive thing a review can do.
 */

import { describe, expect, it } from 'vitest'

import { readReviewProposal } from './review-proposal'

const FINDING = { severity: 'blocker', summary: 'the migration is missing' }

describe('readReviewProposal — what the agent stated', () => {
  it('reads a verdict, findings and a comment', () => {
    const reading = readReviewProposal({
      verdict: 'fail',
      findings: [{ ...FINDING, filePath: 'src/db.ts', line: 12, workflowEntryId: 'entry-a' }],
      comment: 'Two blockers below.',
    })

    expect(reading).toStrictEqual({
      kind: 'read',
      proposal: {
        verdict: 'fail',
        findings: [
          {
            severity: 'blocker',
            summary: 'the migration is missing',
            filePath: 'src/db.ts',
            workflowEntryId: 'entry-a',
            line: 12,
          },
        ],
        comment: 'Two blockers below.',
      },
    })
  })

  it('leaves out every field the block did not state', () => {
    const reading = readReviewProposal({ verdict: 'pass', findings: [] })

    expect(reading).toStrictEqual({
      kind: 'read',
      proposal: { verdict: 'pass', findings: [] },
    })
  })

  it('carries a ticket transition only when both halves are stated', () => {
    const both = readReviewProposal({
      verdict: 'pass',
      ticketInstruction: 'move it on per the board',
      ticketState: 'Ready for QA',
    })
    const half = readReviewProposal({ verdict: 'pass', ticketInstruction: 'move it on' })

    expect(both).toMatchObject({
      proposal: { ticketInstruction: 'move it on per the board', ticketState: 'Ready for QA' },
    })
    // Half an instruction is passed through as half. `runReviewStep` drops a pair that is not a
    // pair, naming the skill — this module invents neither half.
    expect(half).toStrictEqual({
      kind: 'read',
      proposal: { verdict: 'pass', ticketInstruction: 'move it on' },
    })
  })

  it('passes a missing verdict through for runReviewStep to halt on', () => {
    // Deliberately not this module's refusal: the halt that names sisyphus-review and its digest is
    // more use to an operator than one about a JSON key (FR-058).
    expect(readReviewProposal({ findings: [FINDING] })).toStrictEqual({
      kind: 'read',
      proposal: { findings: [FINDING] },
    })
  })
})

describe('readReviewProposal — what it refuses', () => {
  it('reports a block that says nothing as empty', () => {
    expect(readReviewProposal({})).toStrictEqual({ kind: 'empty' })
    expect(readReviewProposal({ notes: 'looks fine to me' })).toStrictEqual({ kind: 'empty' })
  })

  it('refuses a severity outside the platform’s four rather than downgrading it', () => {
    const reading = readReviewProposal({
      verdict: 'fail',
      findings: [{ severity: 'critical', summary: 'data loss on migrate' }],
    })

    expect(reading.kind).toBe('unusable')
    expect(reading.kind === 'unusable' ? reading.problems.join(' ') : '').toContain(
      'blocker filed as a note is a blocker lost',
    )
  })

  it('refuses a finding with no summary rather than dropping it', () => {
    const reading = readReviewProposal({
      verdict: 'fail',
      findings: [FINDING, { severity: 'major', summary: '  ' }],
    })

    expect(reading.kind).toBe('unusable')
    expect(reading.kind === 'unusable' ? reading.problems.join(' ') : '').toContain(
      'finding 1 says nothing',
    )
  })

  it('refuses a verdict that is neither pass nor fail', () => {
    const reading = readReviewProposal({ verdict: 'needs-work' })

    expect(reading.kind).toBe('unusable')
    expect(reading.kind === 'unusable' ? reading.problems.join(' ') : '').toContain(
      'An undecided review is not a pass',
    )
  })

  it('refuses a line number that is not a positive whole number', () => {
    const reading = readReviewProposal({
      verdict: 'fail',
      findings: [{ ...FINDING, line: 0 }],
    })

    expect(reading.kind).toBe('unusable')
  })

  it('refuses findings that are not a list', () => {
    expect(readReviewProposal({ verdict: 'fail', findings: 'two blockers' }).kind).toBe('unusable')
  })
})
