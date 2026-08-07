import { readFileSync } from 'node:fs'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

/**
 * The detail panel holds the run's queries, so it is exercised here with the tRPC hooks stubbed.
 * That is enough to settle the properties that are genuinely this component's and not a part's: an
 * out-of-scope run must render as **not found**, with no mention of permission (FR-190), and the
 * two slots must contain the real components rather than the copy that says they do not exist
 * (T207, T208).
 *
 * Everything else — the summary, the entries, the timeline, the artifacts, the viewer's own
 * reconciliation, the supervision rule — is asserted in its own file.
 */

const byId = vi.fn((): unknown => ({ data: undefined, error: null, isPending: true }))
const timeline = vi.fn((): unknown => ({ data: undefined, error: null, isPending: true }))
const artifacts = vi.fn((): unknown => ({ data: undefined, error: null, isPending: true }))
const iterations = vi.fn((): unknown => ({ data: undefined, error: null, isPending: true }))
const logSegments = vi.fn((): unknown => ({ data: [], error: null, isPending: false }))
const corrections = vi.fn((): unknown => ({ data: [], error: null, isPending: false }))

vi.mock('@sisyphus-admin/trpc', () => ({
  api: {
    useUtils: () => ({
      workflow: { byId: { invalidate: vi.fn() }, corrections: { invalidate: vi.fn() } },
    }),
    workflow: {
      byId: { useQuery: byId },
      timeline: { useQuery: timeline },
      artifacts: { useQuery: artifacts },
      iterations: { useQuery: iterations },
      logSegments: { useQuery: logSegments },
      corrections: { useQuery: corrections },
      watch: { useMutation: () => ({ mutate: vi.fn() }) },
      unwatch: { useMutation: () => ({ mutate: vi.fn() }) },
      pause: { useMutation: () => ({ mutate: vi.fn() }) },
      resume: { useMutation: () => ({ mutate: vi.fn() }) },
      stop: { useMutation: () => ({ mutate: vi.fn() }) },
      correct: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}))

/**
 * Each rendered log line resolves its own stored text through a bare `useQuery`, which needs a
 * `QueryClientProvider` this repository has no testing library to stand up. Stubbing it is what
 * lets the mount be asserted at all — see `log-viewer/log-segment-line.test.tsx`, which states the
 * same limitation from the other side.
 */
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useQuery: () => ({ data: { state: 'read', text: 'a line of output' }, isError: false }),
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
const detail = (
  entries: readonly Record<string, unknown>[],
  workflowState = 'succeeded',
): unknown => ({
  data: {
    workflow: {
      id: WORKFLOW_ID,
      state: workflowState,
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

  describe('the log viewer (T207, FR-046, SC-002)', () => {
    it('is mounted in its slot, rather than the copy saying it does not exist', () => {
      const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

      expect(markup).toContain('run output')
      expect(markup).not.toContain('The log viewer is not mounted on this page yet')
      expect(markup).not.toContain('not mounted')
    })

    it('says the stream is connecting rather than claiming the run produced nothing', () => {
      const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

      // A log that has quietly stopped arriving looks exactly like an agent that has gone quiet,
      // so the pane always says which of the two it is.
      expect(markup).toContain('connecting')
    })

    it('renders the archived log of a run whose instance is long gone (SC-012)', () => {
      logSegments.mockReturnValueOnce({
        data: [
          { workflowId: WORKFLOW_ID, sequence: 1, s3Key: 'logs/1', byteSize: 12 },
          { workflowId: WORKFLOW_ID, sequence: 2, s3Key: 'logs/2', byteSize: 12 },
        ],
        error: null,
        isPending: false,
      })
      byId.mockReturnValueOnce(detail([entry('api', 'landed')]))

      const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

      expect(markup).toContain('data-sequence="1"')
      expect(markup).toContain('data-sequence="2"')
      expect(markup).toContain('a line of output')
      expect(markup).not.toContain('No output yet.')
    })

    it('is mounted from the id in the URL, so the stream is not held behind the detail read', () => {
      // The viewer's two reads are scoped and answer an out-of-scope run with the same 404 a
      // nonexistent one gets, so there is nothing to leak by starting them early — and SC-002 is
      // measured in seconds.
      const source = readFileSync(new URL('./workflow-detail-panel.tsx', import.meta.url), 'utf8')

      expect(source).toContain('<LogViewer workflowId={workflowId} />')
    })
  })

  describe('the supervision controls (T208, FR-015, FR-049, SC-003)', () => {
    it('are mounted in their slot once the run has been read', () => {
      byId.mockReturnValueOnce(detail([entry('api', 'landed')], 'running'))

      const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

      expect(markup).toContain('RUNNING')
      expect(markup).toContain('Pause')
      expect(markup).not.toContain('Pause, resume, stop and mid-run correction')
    })

    it('report a pause only from the state the executor acknowledged (SC-003)', () => {
      byId.mockReturnValueOnce(detail([entry('api', 'landed')], 'paused'))

      const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

      expect(markup).toContain('PAUSED')
      expect(markup).toContain('instance has confirmed the pause')
    })

    it('are absent while the run is still being read, so no button runs on a guessed id (FR-190)', () => {
      // The placeholder the slot would otherwise show is not the honest thing to say here — the
      // controls exist, the run has not resolved — so the slot holds a reading state instead.
      const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

      expect(markup).toContain('supervision')
      expect(markup).not.toContain('<button')
      expect(markup).not.toContain('Pause, resume, stop and mid-run correction')
    })

    it('are mounted from the id the server returned, never from the one in the URL', () => {
      const source = readFileSync(new URL('./workflow-detail-panel.tsx', import.meta.url), 'utf8')

      expect(source).toContain('workflowId={detail.data.workflow.id}')
      expect(source).not.toContain('<WorkflowSupervision workflowId={workflowId}')
    })
  })

  it('re-reads an unfinished run so a transition needs no manual reload (FR-015)', () => {
    const source = readFileSync(new URL('./workflow-detail-panel.tsx', import.meta.url), 'utf8')

    expect(source).toContain('refetchInterval')
    // And stops once there is nothing left to change.
    expect(source).toContain("supervisionStatus({ workflowState: state }) === 'finished'")
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

  describe('the watch control (T160, FR-138, FR-190)', () => {
    it('is offered on a run the caller can see, whoever owns it', () => {
      byId.mockReturnValueOnce(detail([entry('api', 'landed')]))

      const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

      expect(markup).toContain('notifications for this run')
      expect(markup).toContain('Watch this run')
    })

    it('is absent for a not-found run, so it cannot confirm the run exists (FR-190)', () => {
      // The whole point. A Watch button beside a "no such run" card would be a control whose
      // refusal is a lookup: press it on any id and the answer tells you whether it is real.
      byId.mockReturnValueOnce(notFound)

      const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

      expect(markup).not.toContain('Watch this run')
      expect(markup).not.toContain('notifications for this run')
    })

    it('is absent while the run is still being read, rather than mounted on a guess', () => {
      const markup = renderToStaticMarkup(<WorkflowDetailPanel workflowId={WORKFLOW_ID} />)

      expect(markup).not.toContain('Watch this run')
    })

    it('is mounted from the id the server returned, never from the one in the URL', () => {
      const source = readFileSync(new URL('./workflow-detail-panel.tsx', import.meta.url), 'utf8')

      expect(source).toContain('<WatchToggle workflowId={detail.data.workflow.id} />')
      expect(source).not.toContain('<WatchToggle workflowId={workflowId}')
    })
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
