import { describe, expect, it } from 'vitest'

import { isCurrentNavItem, NAV_SECTIONS, navSectionsForRole } from './nav-items'

const linkTargetsFor = (role: 'admin' | 'engineer'): string[] =>
  navSectionsForRole(role).flatMap((section) => section.items.map((item) => item.href))

const sectionIdsFor = (role: 'admin' | 'engineer'): string[] =>
  navSectionsForRole(role).map((section) => section.id)

describe('the nav model', () => {
  it('names every surface FR-193 requires the sidebar to link to', () => {
    expect(linkTargetsFor('admin')).toStrictEqual([
      '/workflows',
      '/workflows/new',
      '/workflows/needs-attention',
      '/admin/fleet',
      '/admin/bundles',
      '/admin/profiles#workspaces',
      '/admin/profiles',
      '/admin/integrations',
      '/admin/users',
      '/admin/audit',
      '/settings/notifications',
    ])
  })

  it('links to the notification settings screen, which is for every role (T157, FR-193)', () => {
    // It is not under `/admin`, and it must not be filtered out for an engineer: the procedures
    // behind it are `authedProcedure` and the preferences are the caller's own.
    expect(linkTargetsFor('engineer')).toContain('/settings/notifications')
    expect(linkTargetsFor('admin')).toContain('/settings/notifications')
  })

  it('links only to routes the app actually serves', () => {
    for (const item of NAV_SECTIONS.flatMap((section) => section.items)) {
      expect(item.href.startsWith(item.match)).toBe(true)
    }
  })
})

describe('filtering the nav by role', () => {
  it('removes the Admin group entirely for an engineer — the group is absent, not empty', () => {
    expect(sectionIdsFor('engineer')).toStrictEqual(['fleet', 'account'])
    expect(sectionIdsFor('engineer')).not.toContain('admin')
  })

  it('gives an admin the Admin group with all six surfaces', () => {
    const admin = navSectionsForRole('admin').find((section) => section.id === 'admin')

    expect(admin?.items.map((item) => item.label)).toStrictEqual([
      'Setup bundles',
      'Workspaces',
      'Execution profiles',
      'Integrations',
      'Users',
      'Audit',
    ])
  })

  it('hands an engineer no link to any surface behind the admin gate (FR-190)', () => {
    expect(linkTargetsFor('engineer').filter((href) => href.startsWith('/admin'))).toStrictEqual([])
  })

  it('keeps the surfaces an engineer can open', () => {
    expect(linkTargetsFor('engineer')).toStrictEqual([
      '/workflows',
      '/workflows/new',
      '/workflows/needs-attention',
      '/settings/notifications',
    ])
  })

  it('marks nothing disabled, because a disabled link still discloses the surface', () => {
    const engineerItems = navSectionsForRole('engineer').flatMap((section) => section.items)

    expect(engineerItems.every((item) => !item.adminOnly)).toBe(true)
  })
})

describe('marking the current item', () => {
  const workflows = {
    href: '/workflows',
    label: 'Workflows',
    match: '/workflows',
    adminOnly: false,
  }

  it('marks the item whose route is the one being rendered', () => {
    expect(isCurrentNavItem('/workflows', workflows)).toBe(true)
  })

  it('does not light a parent up on a child route, so the mark keeps meaning “you are here”', () => {
    expect(isCurrentNavItem('/workflows/new', workflows)).toBe(false)
    expect(isCurrentNavItem('/workflows/0199a1f4', workflows)).toBe(false)
  })

  it('marks an item whose link carries a fragment by the screen it lands on', () => {
    const workspaces = {
      href: '/admin/profiles#workspaces',
      label: 'Workspaces',
      match: '/admin/profiles',
      adminOnly: true,
    }

    expect(isCurrentNavItem('/admin/profiles', workspaces)).toBe(true)
  })
})
