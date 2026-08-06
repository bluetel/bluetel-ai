import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AdminShell } from './admin-shell'

const render = () =>
  renderToStaticMarkup(
    <AdminShell
      siteUrl="https://sisyphus.example.com"
      eyebrow="Access"
      title="Users"
      summary="Every known user, their role and their active state."
    >
      <p>panel</p>
    </AdminShell>,
  )

describe('AdminShell', () => {
  it('renders the eyebrow, the title, the summary and the page beneath them', () => {
    const markup = render()

    expect(markup).toContain('Access')
    expect(markup).toContain('Users')
    expect(markup).toContain('Every known user, their role and their active state.')
    expect(markup).toContain('panel')
  })

  it('sets the eyebrow in label-mono and the title in the heading token', () => {
    const markup = render()

    expect(markup).toContain('type-label-mono')
    expect(markup).toContain('type-heading')
  })

  it('holds the page to the column ceiling with the page gutter', () => {
    const markup = render()

    expect(markup).toContain('max-w-column')
    expect(markup).toContain('p-gutter')
  })

  it('keeps prose to the readable measure rather than the full column', () => {
    expect(render()).toContain('measure-prose')
  })

  it('carries no literal colour, size or radius', () => {
    expect(render()).not.toMatch(/#[0-9a-fA-F]{3,8}|\d+(?:px|rem)/)
  })
})
