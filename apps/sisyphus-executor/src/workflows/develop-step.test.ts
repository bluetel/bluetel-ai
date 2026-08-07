import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ReviewerSummaryInput } from '../report'
import type { SkillReferenceReport, SkillSource } from '../skills'

import type { DevelopmentProposal, DevelopmentRequest } from './develop-step'
import { DEVELOP_STEP, runDevelopStep } from './develop-step'

/**
 * One development pass — the skill first, the agent second, and nothing filled in (FR-057,
 * FR-058, FR-059).
 */

const SKILL_BODY = 'Branch from whatever this repository calls its integration line.'

const summary = (): ReviewerSummaryInput => ({
  entries: [{ repository: 'git.test/app', changed: true, description: 'Bounded the retry loop.' }],
  decisions: ['Bounded at five attempts.'],
  assumptions: [],
  notDone: [],
  uncertainties: [],
})

/** A primary entry with a real skill file on disk, so resolution is exercised rather than faked. */
const entryWithSkill = async (skills: Readonly<Record<string, string>>): Promise<SkillSource> => {
  const root = await mkdtemp(join(tmpdir(), 'sisyphus-develop-'))

  for (const [name, body] of Object.entries(skills)) {
    const path = join(root, '.claude', 'skills', name, 'SKILL.md')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body, 'utf8')
  }

  return { entryId: 'entry-primary', path: root }
}

const completeProposal = (overrides: Partial<DevelopmentProposal> = {}): DevelopmentProposal => ({
  conventions: {
    remote: 'origin',
    branchName: 'ticket-1234-bounded-retry',
    baseBranch: 'integration-line',
    pullRequestTitle: 'ABC-1234 Bound the retry loop',
  },
  summary: summary(),
  ...overrides,
})

describe('runDevelopStep', () => {
  it('resolves the skill before the agent is asked anything, and reports its digest', async () => {
    const source = await entryWithSkill({ 'sisyphus-dev': SKILL_BODY })
    const reports: SkillReferenceReport[] = []
    const seen: DevelopmentRequest[] = []

    const result = await runDevelopStep({
      ordinal: 1,
      source,
      report: (report) => {
        reports.push(report)
      },
      feedback: [],
      developer: async (request) => {
        seen.push(request)
        return Promise.resolve(completeProposal())
      },
    })

    expect(reports).toHaveLength(1)
    expect(reports[0]?.skillName).toBe('sisyphus-dev')
    expect(reports[0]?.contentDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(reports[0]?.phase).toBe(DEVELOP_STEP)
    expect(seen[0]?.skill.body).toBe(SKILL_BODY)
    expect(result.directive.contentDigest).toBe(reports[0]?.contentDigest)
  })

  it('halts naming the skill and the step when the repository has none (FR-058)', async () => {
    const source = await entryWithSkill({})
    let asked = false

    await expect(
      runDevelopStep({
        ordinal: 1,
        source,
        report: () => undefined,
        feedback: [],
        developer: async () => {
          asked = true
          return Promise.resolve(completeProposal())
        },
      }),
    ).rejects.toThrow(/sisyphus-dev skill is missing/iu)

    expect(asked).toBe(false)
  })

  it('halts rather than filling in a base branch the agent did not read out of the skill', async () => {
    const source = await entryWithSkill({ 'sisyphus-dev': SKILL_BODY })

    await expect(
      runDevelopStep({
        ordinal: 1,
        source,
        report: () => undefined,
        feedback: [],
        developer: async () =>
          Promise.resolve(
            completeProposal({
              conventions: {
                remote: 'origin',
                branchName: 'ticket-1234',
                pullRequestTitle: 'ABC-1234',
              },
            }),
          ),
      }),
    ).rejects.toThrow(/no base branch to propose onto/iu)
  })

  it('passes the previous review’s findings to the next pass', async () => {
    const source = await entryWithSkill({ 'sisyphus-dev': SKILL_BODY })
    const seen: DevelopmentRequest[] = []

    await runDevelopStep({
      ordinal: 2,
      source,
      report: () => undefined,
      feedback: [{ severity: 'blocker', summary: 'The retry loop has no ceiling.' }],
      developer: async (request) => {
        seen.push(request)
        return Promise.resolve(completeProposal())
      },
    })

    expect(seen[0]?.ordinal).toBe(2)
    expect(seen[0]?.feedback).toHaveLength(1)
  })

  it('leaves the ticket alone when the skill says nothing about it', async () => {
    const source = await entryWithSkill({ 'sisyphus-dev': SKILL_BODY })

    const result = await runDevelopStep({
      ordinal: 1,
      source,
      report: () => undefined,
      feedback: [],
      developer: async () => Promise.resolve(completeProposal()),
    })

    expect(result.ticket).toBeUndefined()
  })

  it('carries the ticket instruction through when the skill gives one', async () => {
    const source = await entryWithSkill({ 'sisyphus-dev': SKILL_BODY })

    const result = await runDevelopStep({
      ordinal: 1,
      source,
      report: () => undefined,
      feedback: [],
      developer: async () =>
        Promise.resolve(
          completeProposal({
            ticketInstruction: 'Move it to the column this board uses for awaiting review.',
            ticketState: 'Awaiting Review',
          }),
        ),
    })

    expect(result.ticket?.toState).toBe('Awaiting Review')
    expect(result.ticket?.directive.skillName).toBe('sisyphus-dev')
  })

  it('will not act on a named state with no instruction behind it', async () => {
    const source = await entryWithSkill({ 'sisyphus-dev': SKILL_BODY })

    const result = await runDevelopStep({
      ordinal: 1,
      source,
      report: () => undefined,
      feedback: [],
      developer: async () => Promise.resolve(completeProposal({ ticketState: 'Awaiting Review' })),
    })

    expect(result.ticket).toBeUndefined()
  })
})
