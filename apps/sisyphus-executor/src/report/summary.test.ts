import { describe, expect, it, vi } from 'vitest'

import type { SanitisedText } from '../output'

import type { ReviewerSummaryInput, ReviewerSummarySink } from './summary'
import { buildReviewerSummary, createArtifactSummarySink, publishReviewerSummary } from './summary'

const WORKFLOW_ID = '3f7b6d2a-1c5e-4a9b-8d3f-2e6c9a4b1d70'

const input = (overrides: Partial<ReviewerSummaryInput> = {}): ReviewerSummaryInput => ({
  entries: [
    {
      repository: 'https://forge.test/acme/web',
      subdirectory: 'web',
      changed: true,
      description: 'Added the retry schedule to the reporting client.',
      paths: ['src/report/backoff.ts'],
    },
  ],
  decisions: ['Kept the existing rate limiter rather than adding a second one.'],
  assumptions: ['The base branch is protected, so nothing was force pushed.'],
  notDone: ['Left the database migration alone; it is owned by another change.'],
  uncertainties: ['The jitter constant is a guess and may want tuning.'],
  ...overrides,
})

describe('buildReviewerSummary', () => {
  it('answers all four of FR-153’s questions under their own headings', () => {
    const summary = buildReviewerSummary(input())

    expect(summary.markdown).toContain('## What changed, and where')
    expect(summary.markdown).toContain('## Decisions and assumptions')
    expect(summary.markdown).toContain('## Deliberately not done')
    expect(summary.markdown).toContain('## Where this run was uncertain')
  })

  it('locates the change per workspace entry', () => {
    const summary = buildReviewerSummary(
      input({
        entries: [
          {
            repository: 'https://forge.test/acme/web',
            subdirectory: 'web',
            changed: true,
            description: 'Reporting client.',
            pullRequestUrl: 'https://forge.test/acme/web/pull/12',
          },
          {
            repository: 'https://forge.test/acme/api',
            subdirectory: 'api',
            changed: false,
            description: 'Read for context only.',
          },
        ],
      }),
    )

    expect(summary.markdown).toContain('https://forge.test/acme/web')
    expect(summary.markdown).toContain('`web`')
    expect(summary.markdown).toContain('Pull request: https://forge.test/acme/web/pull/12')
    // A reviewer of one PR is told the other entry exists and was untouched.
    expect(summary.markdown).toContain('No changes. Read for context only.')
  })

  it('says a section is empty rather than omitting it', () => {
    const summary = buildReviewerSummary(input({ notDone: [], uncertainties: [] }))

    expect(summary.markdown).toContain('## Deliberately not done')
    expect(summary.markdown).toContain('_None recorded._')
    // "It had no reservations" must be distinguishable from "it did not answer".
    expect(summary.markdown.match(/_None recorded\._/g)).toHaveLength(2)
  })

  it('refuses a summary that describes no entry', () => {
    expect(() => buildReviewerSummary(input({ entries: [] }))).toThrow(
      /no workspace entry is described/,
    )
  })

  it('refuses an entry with nothing said about it', () => {
    expect(() =>
      buildReviewerSummary(
        input({
          entries: [
            { repository: 'https://forge.test/acme/web', changed: true, description: '  ' },
          ],
        }),
      ),
    ).toThrow(/no description of what changed/)
  })

  it('redacts a known credential before the summary can reach a pull request', () => {
    const summary = buildReviewerSummary(
      input({
        decisions: ['Reused the installed credential value SUPER-SECRET-VALUE-0123456789.'],
        secrets: [{ name: 'bundle credential', value: 'SUPER-SECRET-VALUE-0123456789' }],
      }),
    )

    expect(summary.markdown).not.toContain('SUPER-SECRET-VALUE-0123456789')
  })
})

describe('createArtifactSummarySink', () => {
  it('stores the body before registering the row that points at it', async () => {
    const order: string[] = []
    const put = vi.fn(async () => {
      order.push('put')

      await Promise.resolve()
    })
    const registerArtifact = vi.fn(async () => {
      order.push('register')

      await Promise.resolve()
    })

    const sink = createArtifactSummarySink({
      workflowId: WORKFLOW_ID,
      store: { put },
      client: { registerArtifact },
    })

    await sink.publish({ summary: 'body' as SanitisedText })

    expect(order).toEqual(['put', 'register'])
    expect(put).toHaveBeenCalledWith({
      key: `workflows/${WORKFLOW_ID}/reviewer-summary.md`,
      body: 'body',
    })
    expect(registerArtifact).toHaveBeenCalledWith({
      kind: 'report',
      s3Key: `workflows/${WORKFLOW_ID}/reviewer-summary.md`,
      byteSize: 4,
    })
  })
})

describe('publishReviewerSummary', () => {
  it('records the summary and hands back the markdown for every pull request', async () => {
    const published: string[] = []
    const sink: ReviewerSummarySink = {
      publish: async ({ summary }) => {
        published.push(summary)

        await Promise.resolve()
      },
    }

    const summary = await publishReviewerSummary(sink, input())

    expect(published).toEqual([summary.markdown])
    expect(summary.markdown).toContain('## Summary for the reviewer')
  })

  it('publishes nothing when the summary is incomplete', async () => {
    const publish = vi.fn(async () => Promise.resolve())

    await expect(publishReviewerSummary({ publish }, input({ entries: [] }))).rejects.toThrow(
      /incomplete/,
    )
    expect(publish).not.toHaveBeenCalled()
  })
})
