import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { EntryResultsReadouts } from './entry-result-readouts'
import { EntryResultsCard } from './entry-results-card'

const landed = {
  id: 'entry-api',
  repositoryUrl: 'https://git.test/acme/api',
  standing: 'landed' as const,
  role: 'primary',
  commit: 'a'.repeat(40),
  pullRequestUrl: 'https://git.test/acme/api/pull/1',
}

const failed = {
  id: 'entry-web',
  repositoryUrl: 'https://git.test/acme/web',
  standing: 'failed' as const,
  role: 'secondary',
  commit: 'b'.repeat(40),
  pullRequestUrl: null,
}

const results = (overrides: Partial<EntryResultsReadouts> = {}): EntryResultsReadouts => ({
  entries: [landed],
  counts: { landed: 1, unchanged: 0, failed: 0, pending: 0 },
  readout: 'landed 1 / 1',
  isPartial: false,
  statement: 'All of 1 repository are accounted for: 1 landed, 0 unchanged.',
  sharedBranch: 'sisyphus/abc-12',
  pullRequestCount: 1,
  ...overrides,
})

const partial = (): EntryResultsReadouts =>
  results({
    entries: [landed, failed],
    counts: { landed: 1, unchanged: 0, failed: 1, pending: 0 },
    readout: 'landed 1 / 2',
    isPartial: true,
    statement: '1 of 2 repositories landed and 1 failed. This is a partial result, not a success.',
    pullRequestCount: 1,
  })

describe('EntryResultsCard', () => {
  it('states where the run got to, in words (FR-118)', () => {
    const markup = renderToStaticMarkup(<EntryResultsCard results={partial()} />)

    expect(markup).toContain('This is a partial result, not a success.')
    expect(markup).toContain('landed 1 / 2')
  })

  it('announces the partial result politely rather than interrupting', () => {
    const markup = renderToStaticMarkup(<EntryResultsCard results={partial()} />)

    expect(markup).toContain('role="status"')
    expect(markup).not.toContain('role="alert"')
  })

  it('does not add the partial-result explanation to a run that finished', () => {
    const markup = renderToStaticMarkup(<EntryResultsCard results={results()} />)

    expect(markup).not.toContain('Some repositories carry this change')
  })

  it('shows every standing, including the ones at zero', () => {
    // A count that disappears when it is zero makes "nothing failed" and "nobody looked" the same
    // rendering.
    const markup = renderToStaticMarkup(<EntryResultsCard results={partial()} />)

    for (const label of ['landed', 'unchanged', 'failed', 'not reported']) {
      expect(markup).toContain(label)
    }
  })

  it('links each entry’s pull request, at most one per entry (FR-115)', () => {
    const markup = renderToStaticMarkup(<EntryResultsCard results={partial()} />)

    expect(markup.match(/https:\/\/git\.test\/acme\/api\/pull\/1/g)).toHaveLength(2)
    expect(markup).not.toContain('/acme/web/pull/')
  })

  it('names the shared branch when there is more than one pull request to join (FR-116)', () => {
    const markup = renderToStaticMarkup(
      <EntryResultsCard
        results={results({
          entries: [landed, { ...failed, standing: 'landed' }],
          pullRequestCount: 2,
        })}
      />,
    )

    expect(markup).toContain('shared branch')
    expect(markup).toContain('sisyphus/abc-12')
  })

  it('does not name a shared branch when there is nothing to share it with', () => {
    expect(renderToStaticMarkup(<EntryResultsCard results={results()} />)).not.toContain(
      'shared branch',
    )
  })

  it('offers no control to act on a repository that did not land (FR-079)', () => {
    const markup = renderToStaticMarkup(<EntryResultsCard results={partial()} />)

    expect(markup).not.toContain('<button')
    expect(markup).not.toMatch(/retry|rebase/i)
  })

  it('says it is reading rather than claiming a clean sweep', () => {
    const markup = renderToStaticMarkup(<EntryResultsCard results={results()} loading />)

    expect(markup).toContain('reading')
    expect(markup).not.toContain('accounted for')
  })

  it('says a run with no entries has none', () => {
    const markup = renderToStaticMarkup(
      <EntryResultsCard
        results={results({
          entries: [],
          counts: { landed: 0, unchanged: 0, failed: 0, pending: 0 },
          statement: 'This run has no workspace entries recorded.',
          pullRequestCount: 0,
        })}
      />,
    )

    expect(markup).toContain('no workspace entries recorded')
  })

  it('carries no literal colour, size or spacing of its own (SC-015)', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('entry-results-card.tsx', import.meta.url), 'utf8'),
    )

    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(source).not.toMatch(/\b\d+(\.\d+)?(px|rem|em)\b/)
  })
})
