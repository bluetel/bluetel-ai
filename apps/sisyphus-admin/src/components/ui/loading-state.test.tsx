import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { EmptyState } from './empty-state'
import { LoadingState } from './loading-state'

describe('LoadingState', () => {
  it('says what is being read', () => {
    expect(renderToStaticMarkup(<LoadingState>reading the users</LoadingState>)).toContain(
      'reading the users',
    )
  })

  it('falls back to the same word the card header’s chip uses', () => {
    expect(renderToStaticMarkup(<LoadingState />)).toContain('reading')
  })

  it('is announced, because it appears without the operator doing anything', () => {
    expect(renderToStaticMarkup(<LoadingState />)).toContain('role="status"')
  })

  it('is not a spinner: there is no indeterminate ring anywhere in it', () => {
    const markup = renderToStaticMarkup(<LoadingState />)

    expect(markup).not.toContain('animate-spin')
    expect(markup).not.toContain('svg')
  })

  it('occupies the same line as the empty state it will be replaced by', () => {
    const loading = renderToStaticMarkup(<LoadingState>same words</LoadingState>)
    const empty = renderToStaticMarkup(<EmptyState>same words</EmptyState>)

    expect(loading.replace(' role="status"', '').replace('loading', 'empty')).toBe(empty)
  })
})
