import { describe, expect, it, vi } from 'vitest'

// The bar reaches Auth.js through its server action, and the sidebar reaches the router. Neither
// matters to what the barrel publishes.
vi.mock('./sign-out-action', () => ({ signOutAction: () => Promise.resolve() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/workflows' }))

const shell = await import('./index')

describe('the shell barrel', () => {
  it('publishes the shell’s parts and its nav model', () => {
    expect(Object.keys(shell).sort()).toStrictEqual([
      'NAV_SECTIONS',
      'PageHeader',
      'Sidebar',
      'TopBar',
      'isCurrentNavItem',
      'navSectionsForRole',
    ])
  })

  it('does not publish the sign-out action, so there is one sign-out control', () => {
    expect(Object.keys(shell)).not.toContain('signOutAction')
  })
})
