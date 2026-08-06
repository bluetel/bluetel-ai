import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { WorkflowArtifactsCard } from './workflow-artifacts-card'
import type { ArtifactReadouts } from './workflow-detail-readouts'

const pullRequest: ArtifactReadouts = {
  id: 'artifact-1',
  kind: 'pull request',
  location: 'https://git.test/acme/api/pull/9',
  externalUrl: 'https://git.test/acme/api/pull/9',
  recordedAt: '2026-08-05 09:04',
  expired: undefined,
}

const storedDiff: ArtifactReadouts = {
  id: 'artifact-2',
  kind: 'diff',
  location: 'artifacts/diff.patch',
  externalUrl: null,
  recordedAt: '2026-08-05 09:04',
  expired: undefined,
}

describe('WorkflowArtifactsCard', () => {
  it('links an external artifact', () => {
    const markup = renderToStaticMarkup(<WorkflowArtifactsCard artifacts={[pullRequest]} />)

    expect(markup).toContain('href="https://git.test/acme/api/pull/9"')
    expect(markup).toContain('pull request')
  })

  it('shows a stored artifact as its object key rather than as a link that does nothing', () => {
    const markup = renderToStaticMarkup(<WorkflowArtifactsCard artifacts={[storedDiff]} />)

    expect(markup).toContain('artifacts/diff.patch')
    expect(markup).not.toContain('href="artifacts/diff.patch"')
  })

  it('keeps an expired artifact listed with its expiry, so a gap reads as retention (SC-012)', () => {
    const markup = renderToStaticMarkup(
      <WorkflowArtifactsCard artifacts={[{ ...storedDiff, expired: '2026-09-01 00:00' }]} />,
    )

    expect(markup).toContain('expired')
    expect(markup).toContain('2026-09-01 00:00')
    expect(markup).toContain('recorded 1')
  })

  it('says it is reading rather than claiming the run produced nothing', () => {
    const markup = renderToStaticMarkup(<WorkflowArtifactsCard artifacts={[]} loading />)

    expect(markup).toContain('reading')
    expect(markup).not.toContain('nothing has been recorded for this run')
  })

  it('says nothing was recorded once the read has finished', () => {
    const markup = renderToStaticMarkup(<WorkflowArtifactsCard artifacts={[]} />)

    expect(markup).toContain('nothing has been recorded for this run')
  })

  it('writes no literal colour, size or radius (SC-015)', () => {
    const markup = renderToStaticMarkup(
      <WorkflowArtifactsCard artifacts={[pullRequest, storedDiff]} />,
    )

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="[^"]*\d+(px|rem)/)
  })
})
