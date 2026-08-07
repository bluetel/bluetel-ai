import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PageHeader } from './page-header'

const render = () =>
  renderToStaticMarkup(
    <PageHeader
      eyebrow="Access"
      title="Users"
      summary="Every known user, their role and their active state."
    />,
  )

describe('PageHeader', () => {
  it('renders the eyebrow, the title and the summary', () => {
    const markup = render()

    expect(markup).toContain('Access')
    expect(markup).toContain('Users')
    expect(markup).toContain('Every known user, their role and their active state.')
  })

  it('sets the eyebrow in label-mono and the title in the heading token', () => {
    const markup = render()

    expect(markup).toContain('type-label-mono')
    expect(markup).toContain('type-heading')
  })

  it('keeps prose to the readable measure rather than the full column', () => {
    expect(render()).toContain('measure-prose')
  })

  it('is a header and nothing more — not a second main landmark inside the shell’s (T156)', () => {
    const markup = render()

    expect(markup.startsWith('<header')).toBe(true)
    expect(markup).not.toContain('<main')
  })

  it('sets no page column and no gutter, because the shell layout owns both now (T156)', () => {
    const markup = render()

    expect(markup).not.toContain('max-w-column')
    expect(markup).not.toContain('p-gutter')
  })

  it('carries no literal colour, size or radius', () => {
    expect(render()).not.toMatch(/#[0-9a-fA-F]{3,8}|\d+(?:px|rem)/)
  })
})
