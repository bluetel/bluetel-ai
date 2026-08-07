import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

/**
 * The detail panel holds three queries, so it is exercised here with the tRPC hooks stubbed. That
 * is enough to settle the one property that is genuinely this component's and not a part's: an
 * out-of-scope run must render as **not found**, with no mention of permission (FR-190).
 *
 * Everything else — the summary, the entries, the timeline, the artifacts, the two slots — is
 * asserted in its own file.
 */

const byId = vi.fn((): unknown => ({ data: undefined, error: null, isPending: true }))
const timeline = vi.fn((): unknown => ({ data: undefined, error: null, isPending: true }))
const artifacts = vi.fn((): unknown => ({ data: undefined, error: null, isPending: true }))
const iterations = vi.fn((): unknown => ({ data: undefined, error: null, isPending: true }))

vi.mock('@sisyphus-admin/trpc', () => ({
  api: {
    workflow: {
      byId: { useQuery: byId },
      timeline: { useQuery: timeline },
      artifacts: { useQuery: artifacts },
      iterations: { useQuery: iterations },
    },
  },
}))

const { WorkflowDetailPanel } = await import('./workflow-detail-panel')

const WORKFLOW_ID = '0199a1f4-0000-7000-8000-0000000000ab'

const notFound = { data: undefined, error: { data: { code: 'NOT_FOUND' } }, isPending: false }

const entry = (repository: string, entryResult: string | null): Record<string, unknown> => ({
  id: `entry-${repository}`,
  repositoryUrl: `https://git.test/acme/${repository}`,
  baseBranch: 'main',
  subdirectory: repository,
  isPrimary: repository === 'api',
  resolvedCommit: 'a'.repeat(40),
  wasChanged: entryResult === 'landed',
  entryResult,
  pullRequestUrl: entryResult === 'landed' ? `https://git.test/acme/${repository}/pull/1` : null,
  stalenessNote: null,
})

/** One `workflow.byId` answer, wide enough for the readouts the panel derives from it. */
const detail = (entries: readonly Record<string, unknown>[]): unknown => ({
  data: {
    workflow: {
      id: WORKFLOW_ID,
      state: 'succeeded',
      type: 'delegated',
      originatingIntegrationId: null,
      ticketReference: null,
      model: 'claude-opus-5',
      instanceType: 'm7i.large',
      purchaseMode: 'spot',
      resultBranchName: 'sisyphus/abc-12',
      createdAt: new Date('2026-08-05T09:00:00.000Z'),
      updatedAt: new Date('2026-08-05T09:30:00.000Z'),
      turnsUsed: 4,
      turnCap: 40,
      spendUsed: '1.0000',
      spendCap: '25.0000',
      terminalOutcome: 'needs_attention',
      outcomeReason: null,
      reviewerSummary: null,
      needsReassignment: false,
      promptTruncated: false,
    },
    initiatedByDisplayName: 'Someone',
    originatingIntegrationName: null,
    ownerDisplayName: 'Someone',
    workspaceName: 'acme',
    executionProfileName: 'default',
    entries,
  },
  error: null,
  isPending: false,
})

describe('WorkflowDetailPanel', () => {
  it('renders an out-of-scope run as not found (FR-190)', () => {
    byId.mockReturnValueOnce(notFound)

    const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

    expect(markup).toContain('not found')
    expect(markup).toContain('No such run.')
  })

  it('never says “permission”, which would confirm the run exists', () => {
    byId.mockReturnValueOnce(notFound)

    const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

    expect(markup.toLowerCase()).not.toContain('permission')
    expect(markup.toLowerCase()).not.toContain('forbidden')
    expect(markup.toLowerCase()).not.toContain('not allowed')
  })

  it('renders nothing else at all for a not-found run — no slots, no empty cards to read', () => {
    byId.mockReturnValueOnce(notFound)

    const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

    expect(markup).not.toContain('supervision')
    expect(markup).not.toContain('timeline')
    expect(markup).not.toContain('artifacts')
  })

  it('omits the iteration card entirely for a run with no passes (FR-061)', () => {
    // A delegated run was never in the develop→review loop. A card reading "0 of 3" would describe
    // a loop it was never subject to, which is worse than saying nothing.
    iterations.mockReturnValueOnce({ data: [], error: null, isPending: false })

    const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

    expect(markup).not.toContain('iterations')
  })

  it('renders the iteration card once a run has passes', () => {
    iterations.mockReturnValueOnce({
      data: [
        {
          iteration: {
            id: 'iteration-1',
            workflowId: WORKFLOW_ID,
            ordinal: 1,
            reviewVerdict: 'fail',
            startedAt: new Date('2026-08-05T09:00:00Z'),
            endedAt: new Date('2026-08-05T09:30:00Z'),
          },
          findings: [],
        },
      ],
      error: null,
      isPending: false,
    })

    const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

    expect(markup).toContain('iterations')
    expect(markup).toContain('1 of 3')
  })

  it('leaves a named slot for the log viewer and one for the supervision controls', () => {
    const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

    expect(markup).toContain('The log viewer is not mounted on this page yet')
    expect(markup).toContain('Pause, resume, stop and mid-run correction')
  })

  it('says it is reading the run rather than showing an empty summary', () => {
    const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

    expect(markup).toContain('reading this run')
  })

  it('maps any other refusal to a machine code and a next action (FR-031)', () => {
    byId.mockReturnValueOnce({
      data: undefined,
      error: { data: { code: 'UNAUTHORIZED' } },
      isPending: false,
    })

    const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

    expect(markup).toContain('E_NOT_SIGNED_IN')
    expect(markup).toContain('Sign in again')
  })

  describe('the entry results card (T108, FR-118)', () => {
    it('is mounted, and states a partial result in words', () => {
      byId.mockReturnValueOnce(detail([entry('api', 'landed'), entry('web', 'failed')]))

      const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

      expect(markup).toContain('entry results')
      expect(markup).toContain('This is a partial result, not a success.')
      expect(markup).toContain('landed 1 / 2')
    })

    it('counts a repository the run never reached against it rather than leaving it blank', () => {
      byId.mockReturnValueOnce(detail([entry('api', 'landed'), entry('web', null)]))

      const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

      expect(markup).toContain('never reported')
      expect(markup).toContain('not reported')
    })

    it('is absent while the run is still being read, rather than claiming nothing to report', () => {
      const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

      expect(markup).not.toContain('entry results')
    })
  })
})
