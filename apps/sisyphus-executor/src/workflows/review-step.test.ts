import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { SkillReferenceReport, SkillSource } from '../skills'

import type { ReviewRequest, ReviewTarget } from './review-step'
import { REVIEW_STEP, runReviewStep } from './review-step'

/**
 * One review pass — the rubric read from the skill, and two self-contradictions refused
 * (FR-057, FR-058, FR-063).
 */

const RUBRIC = 'Block anything that changes behaviour without a test beside it.'

const entryWithSkill = async (skills: Readonly<Record<string, string>>): Promise<SkillSource> => {
  const root = await mkdtemp(join(tmpdir(), 'sisyphus-review-'))

  for (const [name, body] of Object.entries(skills)) {
    const path = join(root, '.claude', 'skills', name, 'SKILL.md')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body, 'utf8')
  }

  return { entryId: 'entry-primary', path: root }
}

const target = (number: number, entryId = 'entry-a'): ReviewTarget => ({
  entryId,
  repository: 'git.test/app',
  pullRequestNumber: number,
  pullRequestUrl: `https://git.test/app/pull/${String(number)}`,
})

describe('runReviewStep', () => {
  it('hands the rubric to the agent and reports the skill it read (FR-059)', async () => {
    const source = await entryWithSkill({ 'sisyphus-review': RUBRIC })
    const reports: SkillReferenceReport[] = []
    const seen: ReviewRequest[] = []

    const assessment = await runReviewStep({
      source,
      report: (report) => {
        reports.push(report)
      },
      targets: [target(7)],
      reviewer: async (request) => {
        seen.push(request)
        return Promise.resolve({ verdict: 'pass' })
      },
    })

    expect(seen[0]?.skill.body).toBe(RUBRIC)
    expect(reports[0]?.phase).toBe(REVIEW_STEP)
    expect(assessment.verdict).toBe('pass')
    expect(assessment.directive.contentDigest).toBe(reports[0]?.contentDigest)
  })

  it('halts naming the skill and the step when the repository has none (FR-058)', async () => {
    const source = await entryWithSkill({})

    await expect(
      runReviewStep({
        source,
        report: () => undefined,
        targets: [target(7)],
        reviewer: async () => Promise.resolve({ verdict: 'pass' }),
      }),
    ).rejects.toThrow(/sisyphus-review skill is missing/iu)
  })

  it('refuses an undecided review rather than reading it as a pass', async () => {
    const source = await entryWithSkill({ 'sisyphus-review': RUBRIC })

    await expect(
      runReviewStep({
        source,
        report: () => undefined,
        targets: [target(7)],
        reviewer: async () => Promise.resolve({}),
      }),
    ).rejects.toThrow(/no verdict/iu)
  })

  it('refuses a failure that names nothing to fix, which would loop forever', async () => {
    const source = await entryWithSkill({ 'sisyphus-review': RUBRIC })

    await expect(
      runReviewStep({
        source,
        report: () => undefined,
        targets: [target(7)],
        reviewer: async () => Promise.resolve({ verdict: 'fail', findings: [] }),
      }),
    ).rejects.toThrow(/named nothing to fix/iu)
  })

  it('records the contradiction against the skill before it throws', async () => {
    const source = await entryWithSkill({ 'sisyphus-review': RUBRIC })
    const reports: SkillReferenceReport[] = []

    await expect(
      runReviewStep({
        source,
        report: (report) => {
          reports.push(report)
        },
        targets: [target(7)],
        reviewer: async () => Promise.resolve({}),
      }),
    ).rejects.toThrow()

    expect(reports.at(-1)?.unavailableReason).toContain('contradictory')
  })

  it('refuses to record a verdict about nothing', async () => {
    const source = await entryWithSkill({ 'sisyphus-review': RUBRIC })

    await expect(
      runReviewStep({
        source,
        report: () => undefined,
        targets: [],
        reviewer: async () => Promise.resolve({ verdict: 'pass' }),
      }),
    ).rejects.toThrow(/nothing to review/iu)
  })

  it('leaves the ticket alone when the skill says nothing about it (FR-063)', async () => {
    const source = await entryWithSkill({ 'sisyphus-review': RUBRIC })

    const assessment = await runReviewStep({
      source,
      report: () => undefined,
      targets: [target(7)],
      reviewer: async () => Promise.resolve({ verdict: 'pass', comment: 'Looks right.' }),
    })

    expect(assessment.ticket).toBeUndefined()
    expect(assessment.comment).toBe('Looks right.')
  })

  it('carries the transition the skill prescribed, in the board’s own words', async () => {
    const source = await entryWithSkill({ 'sisyphus-review': RUBRIC })

    const assessment = await runReviewStep({
      source,
      report: () => undefined,
      targets: [target(7)],
      reviewer: async () =>
        Promise.resolve({
          verdict: 'pass',
          ticketInstruction: 'A passing review moves it along the board.',
          ticketState: 'Ready to Ship',
        }),
    })

    expect(assessment.ticket?.toState).toBe('Ready to Ship')
    expect(assessment.ticket?.directive.skillName).toBe('sisyphus-review')
  })
})
