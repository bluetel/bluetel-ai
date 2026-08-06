import { describe, expect, it } from 'vitest'

import type { WorkflowDetailResult } from '../workflow-detail-readouts'

import { toEntryResultsReadouts } from './entry-result-readouts'

/**
 * The aggregate FR-118 turns on: whether a run that says it finished actually finished everywhere.
 */

type EntryResult = 'landed' | 'unchanged' | 'failed' | null

const entry = (
  repository: string,
  entryResult: EntryResult,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: `entry-${repository}`,
  repositoryUrl: `https://git.test/acme/${repository}`,
  isPrimary: repository === 'api',
  resolvedCommit: 'a'.repeat(40),
  entryResult,
  pullRequestUrl: entryResult === 'landed' ? `https://git.test/acme/${repository}/pull/1` : null,
  ...overrides,
})

const detail = (
  entries: readonly Record<string, unknown>[],
  resultBranchName: string | null = 'sisyphus/abc-12',
): WorkflowDetailResult =>
  ({
    workflow: { id: 'run-1', resultBranchName },
    entries,
  }) as unknown as WorkflowDetailResult

describe('toEntryResultsReadouts', () => {
  it('reads a whole set that landed as accounted for', () => {
    const results = toEntryResultsReadouts(detail([entry('api', 'landed'), entry('web', 'landed')]))

    expect(results.counts).toEqual({ landed: 2, unchanged: 0, failed: 0, pending: 0 })
    expect(results.isPartial).toBe(false)
    expect(results.readout).toBe('landed 2 / 2')
    expect(results.statement).toContain('accounted for')
  })

  it('does not count a repository the work did not need to touch as a shortfall', () => {
    const results = toEntryResultsReadouts(
      detail([entry('api', 'landed'), entry('web', 'unchanged')]),
    )

    expect(results.isPartial).toBe(false)
    expect(results.statement).toContain('1 unchanged')
  })

  it('states a partial result in words, not as a ratio (FR-118)', () => {
    const results = toEntryResultsReadouts(detail([entry('api', 'landed'), entry('web', 'failed')]))

    expect(results.isPartial).toBe(true)
    expect(results.statement).toContain('partial result, not a success')
    expect(results.statement).toContain('1 failed')
  })

  it('counts an entry nobody reported on, rather than leaving it blank', () => {
    // The run stopped before it reached the third repository: nothing failed anywhere, and the run
    // is emphatically not finished.
    const results = toEntryResultsReadouts(
      detail([entry('api', 'landed'), entry('web', null), entry('shared', null)]),
    )

    expect(results.counts.pending).toBe(2)
    expect(results.isPartial).toBe(true)
    expect(results.statement).toContain('2 never reported')
  })

  it('names both kinds of shortfall when a run has each', () => {
    const results = toEntryResultsReadouts(
      detail([entry('api', 'landed'), entry('web', 'failed'), entry('shared', null)]),
    )

    expect(results.statement).toContain('1 failed')
    expect(results.statement).toContain('1 never reported')
  })

  it('does not call a total failure a partial result', () => {
    const results = toEntryResultsReadouts(detail([entry('api', 'failed'), entry('web', 'failed')]))

    expect(results.isPartial).toBe(false)
    expect(results.statement).toContain('did not do the work it was given')
  })

  it('reads a run that changed nothing anywhere as finished, not as failed', () => {
    const results = toEntryResultsReadouts(
      detail([entry('api', 'unchanged'), entry('web', 'unchanged')]),
    )

    expect(results.isPartial).toBe(false)
    expect(results.statement).toContain('Nothing needed changing in 2 repositories')
  })

  it('leaves the single-repository run reading exactly as it did', () => {
    const results = toEntryResultsReadouts(detail([entry('api', 'landed')]))

    expect(results.isPartial).toBe(false)
    expect(results.readout).toBe('landed 1 / 1')
    expect(results.statement).toContain('1 repository')
  })

  it('carries the shared branch and how many pull requests there are to join (FR-116)', () => {
    const results = toEntryResultsReadouts(detail([entry('api', 'landed'), entry('web', 'landed')]))

    expect(results.sharedBranch).toBe('sisyphus/abc-12')
    expect(results.pullRequestCount).toBe(2)
  })

  it('reports a commit recorded at checkout even where the entry never delivered (FR-114)', () => {
    const results = toEntryResultsReadouts(detail([entry('api', null)]))

    expect(results.entries[0].commit).toBe('a'.repeat(40))
    expect(results.entries[0].standing).toBe('pending')
  })

  it('says so rather than inventing a commit for an entry that never checked out', () => {
    const results = toEntryResultsReadouts(detail([entry('api', null, { resolvedCommit: null })]))

    expect(results.entries[0].commit).not.toBe('')
    expect(results.entries[0].commit).not.toMatch(/[0-9a-f]{40}/)
  })

  it('distinguishes the primary entry, whose skills governed the run (FR-110)', () => {
    const results = toEntryResultsReadouts(detail([entry('api', 'landed'), entry('web', 'landed')]))

    expect(results.entries.map(({ role }) => role)).toEqual(['primary', 'secondary'])
  })

  it('says a run with no entries has none rather than reporting a clean sweep', () => {
    const results = toEntryResultsReadouts(detail([]))

    expect(results.readout).toBe('landed 0 / 0')
    expect(results.statement).toContain('no workspace entries')
    expect(results.isPartial).toBe(false)
  })

  it('carries no branch when the run recorded none', () => {
    expect(toEntryResultsReadouts(detail([entry('api', 'landed')], null)).sharedBranch).toBeNull()
  })
})
