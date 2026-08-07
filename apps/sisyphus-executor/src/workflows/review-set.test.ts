import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { SkillSource } from '../skills'

import { reviewPullRequestSet } from './review-set'
import type { ReviewRequest, ReviewTarget } from './review-step'

/**
 * A review of a pull request **set** is one evaluation, not N of them (FR-119).
 */

const RUBRIC = 'Weigh the whole change, including the repositories that did not need to move.'

const source = async (): Promise<SkillSource> => {
  const root = await mkdtemp(join(tmpdir(), 'sisyphus-review-set-'))
  const path = join(root, '.claude', 'skills', 'sisyphus-review', 'SKILL.md')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, RUBRIC, 'utf8')

  return { entryId: 'entry-api', path: root }
}

const api: ReviewTarget = {
  entryId: 'entry-api',
  repository: 'git.test/api',
  pullRequestNumber: 11,
  pullRequestUrl: 'https://git.test/api/pull/11',
}

const client: ReviewTarget = {
  entryId: 'entry-client',
  repository: 'git.test/client',
  pullRequestNumber: 4,
  pullRequestUrl: 'https://git.test/client/pull/4',
}

describe('reviewPullRequestSet', () => {
  it('asks the reviewer once, with every pull request — not once per pull request', async () => {
    const requests: ReviewRequest[] = []

    await reviewPullRequestSet({
      source: await source(),
      report: () => undefined,
      targets: [api, client],
      reviewer: async (request) => {
        requests.push(request)
        return Promise.resolve({ verdict: 'pass' })
      },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.targets.map((target) => target.repository)).toEqual([
      'git.test/api',
      'git.test/client',
    ])
  })

  it('records one verdict, so a blocker in one repository fails the clean one too', async () => {
    const assessment = await reviewPullRequestSet({
      source: await source(),
      report: () => undefined,
      targets: [api, client],
      reviewer: async () =>
        Promise.resolve({
          verdict: 'fail',
          findings: [
            {
              workflowEntryId: 'entry-client',
              filePath: 'src/checkout.ts',
              line: 88,
              severity: 'blocker',
              summary: 'The client never sends the field the API now requires.',
            },
          ],
        }),
    })

    expect(assessment.verdict).toBe('fail')
    expect(assessment.targetCount).toBe(2)
    expect(assessment.findingsByEntry.get('entry-client')).toHaveLength(1)
    // The clean repository is present with an empty list rather than absent: a reader has to be
    // able to tell "nothing wrong here" from "not looked at".
    expect(assessment.findingsByEntry.get('entry-api')).toEqual([])
  })

  it('keeps a finding about the set as a whole rather than forcing it onto a repository', async () => {
    const assessment = await reviewPullRequestSet({
      source: await source(),
      report: () => undefined,
      targets: [api, client],
      reviewer: async () =>
        Promise.resolve({
          verdict: 'fail',
          findings: [
            {
              severity: 'blocker',
              summary:
                'These two must not be merged independently; the contract breaks between them.',
            },
          ],
        }),
    })

    expect(assessment.setWideFindings).toHaveLength(1)
    expect(assessment.findingsByEntry.get('entry-api')).toEqual([])
  })

  it('anchors each finding to entry, file and line (FR-119)', async () => {
    const assessment = await reviewPullRequestSet({
      source: await source(),
      report: () => undefined,
      targets: [api, client],
      reviewer: async () =>
        Promise.resolve({
          verdict: 'fail',
          findings: [
            {
              workflowEntryId: 'entry-api',
              filePath: 'src/schema.ts',
              line: 4,
              severity: 'major',
              summary: 'Required with no default.',
            },
            {
              workflowEntryId: 'entry-client',
              filePath: 'src/post.ts',
              line: 9,
              severity: 'blocker',
              summary: 'Field not sent.',
            },
          ],
        }),
    })

    expect(assessment.findingsByEntry.get('entry-api')?.[0]?.line).toBe(4)
    expect(assessment.findingsByEntry.get('entry-client')?.[0]?.filePath).toBe('src/post.ts')
  })

  it('halts on a finding anchored at a repository this run never touched', async () => {
    await expect(
      reviewPullRequestSet({
        source: await source(),
        report: () => undefined,
        targets: [api],
        reviewer: async () =>
          Promise.resolve({
            verdict: 'fail',
            findings: [
              { workflowEntryId: 'entry-elsewhere', severity: 'blocker', summary: 'Not ours.' },
            ],
          }),
      }),
    ).rejects.toThrow(/not part of this workspace/iu)
  })

  it('treats a single pull request as a set of one, on the same code path', async () => {
    const requests: ReviewRequest[] = []

    const assessment = await reviewPullRequestSet({
      source: await source(),
      report: () => undefined,
      targets: [api],
      reviewer: async (request) => {
        requests.push(request)
        return Promise.resolve({ verdict: 'pass' })
      },
    })

    expect(requests).toHaveLength(1)
    expect(assessment.targetCount).toBe(1)
  })
})
