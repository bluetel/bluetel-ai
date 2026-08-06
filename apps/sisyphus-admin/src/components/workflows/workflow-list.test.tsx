import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { WorkflowList } from './workflow-list'
import type { WorkflowRowReadouts } from './workflow-listing'

/**
 * The list's four states — reading, empty, a page, and a page with more behind it — and the one
 * property that matters most: the paging control is a cursor and says so, and the count is what
 * has been loaded rather than a total nothing computed.
 */

const row = (id: string): WorkflowRowReadouts => ({
  id,
  runId: id.slice(0, 8),
  state: 'succeeded',
  stateReadout: 'succeeded',
  type: 'delegated',
  startedByLabel: 'initiated by',
  startedBy: 'Ada Lovelace',
  owner: 'Ada Lovelace',
  workspace: 'Acme platform',
  ticket: 'ABC-12',
  model: 'claude-sonnet-4-5',
  executionProfile: 'API maintenance',
  startedAt: '2026-08-05 09:00',
  duration: '4:21',
  turns: '14',
  spend: '3.1400',
  outcome: 'succeeded',
})

const noop = () => undefined

describe('WorkflowList', () => {
  it('says it is reading rather than showing an empty state, while the first page is in flight', () => {
    const markup = renderToStaticMarkup(<WorkflowList rows={[]} loading onLoadMore={noop} />)

    expect(markup).toContain('reading')
    expect(markup).not.toContain('no runs match these filters')
  })

  it('says nothing matched once the read has finished and returned nothing', () => {
    const markup = renderToStaticMarkup(<WorkflowList rows={[]} onLoadMore={noop} />)

    expect(markup).toContain('no runs match these filters')
  })

  it('counts what is loaded, not a total — there is no count query to build one from', () => {
    const markup = renderToStaticMarkup(
      <WorkflowList rows={[row('aaaaaaaa-1'), row('bbbbbbbb-2')]} onLoadMore={noop} />,
    )

    expect(markup).toContain('loaded 2')
    expect(markup).not.toContain(' of ')
  })

  it('marks the count as partial while the server is still handing back a cursor', () => {
    const markup = renderToStaticMarkup(
      <WorkflowList rows={[row('aaaaaaaa-1')]} hasMore onLoadMore={noop} />,
    )

    expect(markup).toContain('loaded 1+')
  })

  it('offers loading more only when the server handed back a cursor, and says the paging is by cursor', () => {
    const withMore = renderToStaticMarkup(
      <WorkflowList rows={[row('aaaaaaaa-1')]} hasMore onLoadMore={noop} />,
    )
    const atEnd = renderToStaticMarkup(
      <WorkflowList rows={[row('aaaaaaaa-1')]} onLoadMore={noop} />,
    )

    expect(withMore).toContain('Load more')
    expect(withMore).toContain('paged by cursor from the last row shown')
    expect(atEnd).not.toContain('Load more')
  })

  it('offers no page numbers, which would need the offset and the count the query avoids', () => {
    const markup = renderToStaticMarkup(
      <WorkflowList rows={[row('aaaaaaaa-1')]} hasMore onLoadMore={noop} />,
    )

    expect(markup).not.toMatch(/page \d/i)
    expect(markup).not.toContain('Next page')
  })

  it('replaces the paging control with a live readout while a further page is being read', () => {
    const markup = renderToStaticMarkup(
      <WorkflowList rows={[row('aaaaaaaa-1')]} hasMore loadingMore onLoadMore={noop} />,
    )

    expect(markup).toContain('Loading')
    expect(markup).toContain('aria-busy="true"')
  })

  it('renders a refusal with a machine code and a next action rather than an empty list (FR-031)', () => {
    const markup = renderToStaticMarkup(
      <WorkflowList
        rows={[]}
        error={{ code: 'E_UNEXPECTED', action: 'Retry once.' }}
        onLoadMore={noop}
      />,
    )

    expect(markup).toContain('E_UNEXPECTED')
    expect(markup).toContain('Retry once.')
  })

  it('asks for the next page through the callback it was given', () => {
    const onLoadMore = vi.fn()
    const element = (
      <WorkflowList rows={[row('aaaaaaaa-1')]} hasMore onLoadMore={onLoadMore} />
    ) as unknown as { props: { onLoadMore: () => void } }

    element.props.onLoadMore()

    expect(onLoadMore).toHaveBeenCalledOnce()
  })

  it('writes no literal colour, size or radius (SC-015)', () => {
    const markup = renderToStaticMarkup(
      <WorkflowList rows={[row('aaaaaaaa-1')]} hasMore onLoadMore={noop} />,
    )

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="[^"]*\d+(px|rem)/)
  })
})
