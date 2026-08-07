import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { WorkflowEntryReadouts } from './workflow-detail-readouts'
import { WorkflowEntriesCard } from './workflow-entries-card'

const entry: WorkflowEntryReadouts = {
  id: 'entry-1',
  repositoryUrl: 'https://git.test/acme/api',
  baseBranch: 'main',
  subdirectory: '.',
  role: 'primary',
  resolvedCommit: 'a'.repeat(40),
  changed: 'changed',
  result: 'landed',
  pullRequestUrl: 'https://git.test/acme/api/pull/9',
  stalenessNote: 'main advanced by 3 commits during this run.',
}

describe('WorkflowEntriesCard', () => {
  it('enumerates the repositories the list only identified as a workspace (FR-012, FR-114)', () => {
    const markup = renderToStaticMarkup(<WorkflowEntriesCard entries={[entry]} />)

    expect(markup).toContain('https://git.test/acme/api')
    expect(markup).toContain('main')
    expect(markup).toContain('primary')
    expect(markup).toContain('landed')
    expect(markup).toContain('entries 1')
  })

  it('links the entry’s pull request, at most one per entry (FR-115)', () => {
    const markup = renderToStaticMarkup(<WorkflowEntriesCard entries={[entry]} />)

    expect(markup.match(/https:\/\/git\.test\/acme\/api\/pull\/9/g)).toHaveLength(2)
  })

  it('shows a partial result honestly — one entry landed beside one that failed (FR-118)', () => {
    const markup = renderToStaticMarkup(
      <WorkflowEntriesCard
        entries={[entry, { ...entry, id: 'entry-2', result: 'failed', pullRequestUrl: null }]}
      />,
    )

    expect(markup).toContain('landed')
    expect(markup).toContain('failed')
  })

  it('records a stale base branch and offers no control to act on it (FR-079)', () => {
    const markup = renderToStaticMarkup(<WorkflowEntriesCard entries={[entry]} />)

    expect(markup).toContain('main advanced by 3 commits')
    expect(markup).not.toContain('Rebase')
    expect(markup).not.toContain('<button')
  })

  it('says it is reading rather than showing an empty state', () => {
    const markup = renderToStaticMarkup(<WorkflowEntriesCard entries={[]} loading />)

    expect(markup).toContain('reading')
    // In the body as well as in the chip: a card whose well is blank while a query runs is
    // indistinguishable from one whose query came back with nothing (FR-201).
    expect(markup).toContain('data-note="loading"')
    expect(markup).toContain('reading this run’s repositories')
    expect(markup).not.toContain('no workspace entries recorded')
    expect(markup).not.toContain('data-note="empty"')
  })

  it('writes no literal colour, size or radius (SC-015)', () => {
    const markup = renderToStaticMarkup(<WorkflowEntriesCard entries={[entry]} />)

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="[^"]*\d+(px|rem)/)
  })
})
