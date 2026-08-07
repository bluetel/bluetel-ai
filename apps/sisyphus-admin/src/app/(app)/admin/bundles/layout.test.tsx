import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

/**
 * The gate, exercised against a stubbed `requireAdminPage`. The decision it wraps —
 * render / sign-in / not-found — has its own suite in `@sisyphus-admin/server`; what is asserted
 * here is that the layout **awaits** it before producing anything.
 */
const { calls, refuse } = vi.hoisted(() => ({ calls: { count: 0 }, refuse: { value: false } }))

vi.mock('@sisyphus-admin/server', () => ({
  requireAdminPage: () => {
    calls.count += 1
    if (refuse.value) throw new Error('NEXT_NOT_FOUND')
    return Promise.resolve({
      id: 'u1',
      email: 'a@b.test',
      displayName: 'A',
      role: 'admin',
      isActive: true,
    })
  },
}))

const { default: BundlesLayout } = await import('./layout')

describe('the bundles layout', () => {
  it('opens the admin gate before rendering anything', async () => {
    calls.count = 0
    refuse.value = false

    const rendered = await BundlesLayout({ children: <p>panel</p> })

    expect(calls.count).toBe(1)
    expect(renderToStaticMarkup(<>{rendered}</>)).toContain('panel')
  })

  it('produces no markup at all when the gate refuses', async () => {
    refuse.value = true

    // `notFound()` and `redirect()` throw, which is the difference between a gate and a hide: the
    // children below are never evaluated and nothing reaches the browser.
    await expect(BundlesLayout({ children: <p>panel</p> })).rejects.toThrow('NEXT_NOT_FOUND')
  })
})
