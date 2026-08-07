import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

/**
 * The sidebar, asserted for the property a screenshot cannot check: that an engineer's document
 * contains **no admin link at all**.
 *
 * "Hidden" and "disabled" both leave the link in the markup, and both answer the question FR-190
 * spends the whole API surface refusing to answer — does this surface exist? So the assertions
 * below are about absence from the rendered string, not about a class.
 */
const pathname = { value: '/workflows' }

vi.mock('next/navigation', () => ({ usePathname: () => pathname.value }))

// `next/link` renders an anchor and needs the app router in a real app; here only the `href` is
// under test, so it is the anchor it becomes.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
    <a href={href} {...rest}>
      {children as never}
    </a>
  ),
}))

const { Sidebar } = await import('./sidebar')

const render = (role: 'admin' | 'engineer', route = '/workflows') => {
  pathname.value = route
  return renderToStaticMarkup(<Sidebar role={role} />)
}

describe('the sidebar for an engineer', () => {
  it('links to the surfaces they can open', () => {
    const markup = render('engineer')

    expect(markup).toContain('href="/workflows"')
    expect(markup).toContain('href="/workflows/new"')
    expect(markup).toContain('href="/workflows/needs-attention"')
  })

  it('contains no admin link anywhere in the document — absent, not disabled (FR-190)', () => {
    const markup = render('engineer')

    expect(markup).not.toContain('/admin')
    expect(markup).not.toContain('disabled')
    expect(markup).not.toContain('aria-disabled')
  })

  it('does not render the Admin heading, which would advertise the group on its own', () => {
    expect(render('engineer')).not.toContain('Admin')
  })

  it('never names a surface it is not linking to', () => {
    const markup = render('engineer')

    for (const surface of ['Setup bundles', 'Workspaces', 'Execution profiles', 'Users', 'Audit']) {
      expect(markup).not.toContain(surface)
    }
  })
})

describe('the sidebar for an admin', () => {
  it('renders the Admin group with all six surfaces (FR-193)', () => {
    const markup = render('admin')

    expect(markup).toContain('Admin')
    expect(markup).toContain('href="/admin/bundles"')
    expect(markup).toContain('href="/admin/profiles#workspaces"')
    expect(markup).toContain('href="/admin/profiles"')
    expect(markup).toContain('href="/admin/integrations"')
    expect(markup).toContain('href="/admin/users"')
    expect(markup).toContain('href="/admin/audit"')
  })

  it('adds fleet oversight, which an engineer cannot open', () => {
    expect(render('admin')).toContain('href="/admin/fleet"')
  })
})

describe('marking where the operator is', () => {
  it('marks the current item for assistive technology', () => {
    expect(render('engineer', '/workflows/new')).toContain('aria-current="page"')
  })

  it('marks it exactly once, so “you are here” names one place', () => {
    const markup = render('engineer', '/workflows/new')

    expect(markup.match(/aria-current="page"/g)).toHaveLength(1)
  })

  it('marks it by something other than colour — a glyph and a weight (FR-201)', () => {
    const markup = render('engineer', '/workflows')

    expect(markup).toContain('▸')
    expect(markup).toContain('font-semibold')
  })

  it('marks nothing on a screen that is not one of the sections', () => {
    const markup = render('engineer', '/workflows/0199a1f4-0000-7000-8000-0000000000ab')

    expect(markup).not.toContain('aria-current')
    expect(markup).not.toContain('▸')
  })
})

describe('the sidebar as a landmark', () => {
  it('is a named navigation landmark rather than a div of links', () => {
    const markup = render('engineer')

    expect(markup).toContain('<nav')
    expect(markup).toContain('aria-label="Primary"')
  })

  it('gives every link the one shared focus ring, so it is operable from the keyboard (FR-201)', () => {
    const markup = render('admin')
    const links = markup.match(/<a /g) ?? []

    expect(links.length).toBeGreaterThan(0)
    expect(markup.match(/focus-ring/g)).toHaveLength(links.length)
  })

  it('carries no literal colour, size or radius (SC-015)', () => {
    expect(render('admin')).not.toMatch(/#[0-9a-fA-F]{3,8}|\d+(?:px|rem)/)
  })
})
