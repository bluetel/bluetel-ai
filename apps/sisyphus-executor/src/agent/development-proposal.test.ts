import { describe, expect, it } from 'vitest'

import { PROPOSAL_KEYS, readDevelopmentProposal, SUMMARY_LISTS } from './development-proposal'

const entry = {
  entryId: 'a3f0c2d4-0000-4000-8000-000000000001',
  repository: 'acme/service',
  subdirectory: 'service',
  changed: true,
  description: 'added the endpoint the ticket asked for',
  paths: ['src/routes/orders.ts'],
}

const summary = {
  entries: [entry],
  decisions: ['reused the existing validator'],
  assumptions: [],
  notDone: ['left the migration alone; it is owned by another team'],
  uncertainties: [],
}

const conventions = {
  remote: 'origin',
  branchName: 'sisyphus/T-101-orders-endpoint',
  baseBranch: 'integration-line',
  pullRequestTitle: 'T-101 orders endpoint',
}

const complete = { conventions, summary, wasChanged: true }

describe('readDevelopmentProposal — a complete block', () => {
  it('reads every field the agent stated', () => {
    const reading = readDevelopmentProposal(complete)

    expect(reading).toEqual({
      kind: 'read',
      proposal: {
        conventions,
        summary: {
          entries: [entry],
          decisions: ['reused the existing validator'],
          assumptions: [],
          notDone: ['left the migration alone; it is owned by another team'],
          uncertainties: [],
        },
        wasChanged: true,
      },
    })
  })

  it('carries the ticket instruction and state through in the skill’s own words', () => {
    const reading = readDevelopmentProposal({
      ...complete,
      ticketInstruction: '  move it once the draft is open  ',
      ticketState: '  awaiting sign-off  ',
    })

    expect(reading).toMatchObject({
      kind: 'read',
      proposal: {
        ticketInstruction: 'move it once the draft is open',
        ticketState: 'awaiting sign-off',
      },
    })
  })

  it('leaves wasChanged off when the agent did not say, rather than assuming a change', () => {
    const reading = readDevelopmentProposal({ conventions, summary })

    expect(reading.kind).toBe('read')
    expect(reading.kind === 'read' && 'wasChanged' in reading.proposal).toBe(false)
  })

  it('accepts a pass that changed nothing', () => {
    const reading = readDevelopmentProposal({
      conventions,
      summary: { ...summary, entries: [{ ...entry, changed: false, description: 'already done' }] },
      wasChanged: false,
    })

    expect(reading).toMatchObject({ kind: 'read', proposal: { wasChanged: false } })
  })

  it('keeps only the conventions that were stated, and does not invent the rest', () => {
    const reading = readDevelopmentProposal({
      conventions: { remote: 'origin', branchName: 'sisyphus/T-101' },
      summary,
    })

    // Incomplete on purpose: `requireDeliveryConventions` halts naming sisyphus-dev and the step,
    // which is FR-058's message and not this module's to compose.
    expect(reading).toMatchObject({
      kind: 'read',
      proposal: { conventions: { remote: 'origin', branchName: 'sisyphus/T-101' } },
    })
  })

  it('treats a blank convention as unstated rather than as a value', () => {
    const reading = readDevelopmentProposal({
      conventions: { ...conventions, baseBranch: '   ' },
      summary,
    })

    expect(reading.kind === 'read' && 'baseBranch' in reading.proposal.conventions).toBe(false)
  })

  it('drops optional entry fields the agent omitted', () => {
    const reading = readDevelopmentProposal({
      conventions,
      summary: {
        ...summary,
        entries: [{ repository: 'acme/service', changed: true, description: 'a change' }],
      },
    })

    expect(reading).toMatchObject({
      kind: 'read',
      proposal: {
        summary: {
          entries: [{ repository: 'acme/service', changed: true, description: 'a change' }],
        },
      },
    })
  })
})

describe('readDevelopmentProposal — a block that says nothing', () => {
  it('reports empty for an object with none of the proposal’s fields', () => {
    expect(readDevelopmentProposal({})).toEqual({ kind: 'empty' })
  })

  it('reports empty rather than incomplete for an unrelated object', () => {
    expect(readDevelopmentProposal({ status: 'ok', note: 'finished' })).toEqual({ kind: 'empty' })
  })

  it('names every field a proposal can carry', () => {
    // The guard above is only as good as this list; a field added to the proposal without being
    // added here would make a block carrying only that field read as empty.
    expect([...PROPOSAL_KEYS]).toEqual([
      'conventions',
      'summary',
      'ticketInstruction',
      'ticketState',
      'wasChanged',
    ])
  })
})

describe('readDevelopmentProposal — a block with gaps', () => {
  it('refuses a proposal with no summary at all', () => {
    const reading = readDevelopmentProposal({ conventions })

    expect(reading.kind).toBe('incomplete')
    expect(reading.kind === 'incomplete' && reading.problems.join(' ')).toContain('no summary')
  })

  it('refuses a summary that describes no workspace entry', () => {
    const reading = readDevelopmentProposal({
      conventions,
      summary: { ...summary, entries: [] },
    })

    expect(reading.kind).toBe('incomplete')
    expect(reading.kind === 'incomplete' && reading.problems.join(' ')).toContain(
      'describes no workspace entry',
    )
  })

  it.each([...SUMMARY_LISTS])('refuses a summary that does not state %s', (key) => {
    const partial = Object.fromEntries(
      Object.entries(summary).filter(([present]) => present !== key),
    )

    const reading = readDevelopmentProposal({ conventions, summary: partial })

    expect(reading.kind).toBe('incomplete')
    expect(reading.kind === 'incomplete' && reading.problems.join(' ')).toContain(
      `does not state ${key}`,
    )
  })

  it('accepts every judgement list as empty, because empty is an answer', () => {
    const reading = readDevelopmentProposal({
      conventions,
      summary: { entries: [entry], decisions: [], assumptions: [], notDone: [], uncertainties: [] },
    })

    expect(reading.kind).toBe('read')
  })

  it('refuses a list containing something that is not text', () => {
    const reading = readDevelopmentProposal({
      conventions,
      summary: { ...summary, decisions: ['fine', 42] },
    })

    expect(reading.kind).toBe('incomplete')
    expect(reading.kind === 'incomplete' && reading.problems.join(' ')).toContain('not text')
  })

  it('refuses an entry that does not say whether it changed', () => {
    const withoutChanged = Object.fromEntries(
      Object.entries(entry).filter(([key]) => key !== 'changed'),
    )
    const reading = readDevelopmentProposal({
      conventions,
      summary: { ...summary, entries: [withoutChanged] },
    })

    expect(reading.kind).toBe('incomplete')
    expect(reading.kind === 'incomplete' && reading.problems.join(' ')).toContain(
      'does not say whether it was changed',
    )
  })

  it('names every gap at once rather than stopping at the first', () => {
    const reading = readDevelopmentProposal({
      conventions,
      summary: { entries: [{ changed: true }] },
    })

    expect(reading.kind).toBe('incomplete')
    expect(reading.kind === 'incomplete' && reading.problems.length).toBeGreaterThan(3)
  })

  it('refuses conventions stated as something other than an object', () => {
    const reading = readDevelopmentProposal({ conventions: 'the usual ones', summary })

    expect(reading.kind).toBe('incomplete')
    expect(reading.kind === 'incomplete' && reading.problems.join(' ')).toContain(
      'not an object of named conventions',
    )
  })

  it('refuses a wasChanged that is not a boolean', () => {
    const reading = readDevelopmentProposal({ conventions, summary, wasChanged: 'yes' })

    expect(reading.kind).toBe('incomplete')
    expect(reading.kind === 'incomplete' && reading.problems.join(' ')).toContain('wasChanged')
  })
})
