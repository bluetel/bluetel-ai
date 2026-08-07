import { readFileSync } from 'node:fs'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

/**
 * The screen resolves the session, calls one procedure and mounts two cards. Four properties are
 * worth asserting: that it is **not** behind the admin gate, because the people it is for are not
 * admins (FR-138); that an unnotifiable account is stated plainly rather than quietly rendered as a
 * success (FR-140, quickstart Scenario 15 step 7); that the identity comes from
 * `workflow.notificationSettings` rather than from a query of its own — the read that replaced the
 * deleted `slack-identity.ts`, and the reason no id from the request can reach it; and that an
 * inactive session produces no markup at all.
 */

const panel = vi.fn(() => null)
const notFound = vi.fn((): never => {
  throw new Error('NEXT_NOT_FOUND')
})

const session = vi.fn((): unknown => ({
  user: {
    id: 'user-a',
    email: 'a@example.com',
    displayName: 'A',
    role: 'engineer',
    isActive: true,
  },
}))

const notificationSettings = vi.fn(
  (): Promise<{ slackUserId: string | null; notifiable: boolean; preferences: unknown[] }> =>
    Promise.resolve({ slackUserId: null, notifiable: false, preferences: [] }),
)

const createServerCaller = vi.fn(() => ({ workflow: { notificationSettings } }))

vi.mock('next/navigation', () => ({ notFound }))

// The shell barrel reaches the panel's server wiring, which validates the environment on import.
vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))

vi.mock('@sisyphus-admin/lib/auth', () => ({
  auth: session,
  isActiveSessionUser: (user: { isActive?: boolean } | undefined) => user?.isActive === true,
}))

vi.mock('@sisyphus-admin/server', () => ({ createServerCaller }))

vi.mock('@sisyphus-admin/components/settings', async () => {
  // The identity card is the real one, because what it says in the absent case is the assertion.
  const actual = await vi.importActual<Record<string, unknown>>(
    '@sisyphus-admin/components/settings/slack-identity-readout',
  )
  return { NotificationPreferencesPanel: panel, SlackIdentityReadout: actual.SlackIdentityReadout }
})

const NotificationSettingsPage = (await import('./page')).default
const { dynamic } = await import('./page')

/** The page with its comments removed, so prose about the gate cannot satisfy a test of the gate. */
const code = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ')

const render = async (): Promise<string> => renderToStaticMarkup(await NotificationSettingsPage())

describe('the /settings/notifications screen', () => {
  it('is not behind the admin gate — the people it is for are not admins (FR-138)', () => {
    expect(code).not.toContain('requireAdminPage')
  })

  it('reads through the API rather than reaching for a handle of its own', () => {
    expect(code).not.toContain('getAuthDatabase')
    expect(code).not.toContain('drizzle-orm')
    expect(code).toContain('notificationSettings')
  })

  it('states plainly that an unnotifiable account will receive nothing (FR-140)', async () => {
    notificationSettings.mockResolvedValueOnce({
      slackUserId: null,
      notifiable: false,
      preferences: [],
    })

    const markup = await render()

    expect(markup).toContain('No Slack identity resolved')
    expect(markup).toContain('notifications will not be delivered')
  })

  it('shows the resolved identity when there is one', async () => {
    notificationSettings.mockResolvedValueOnce({
      slackUserId: 'U0429SLACK',
      notifiable: true,
      preferences: [],
    })

    expect(await render()).toContain('U0429SLACK')
  })

  it('asks for nobody in particular, because the procedure takes no input at all', async () => {
    await render()

    expect(notificationSettings).toHaveBeenCalledWith()
    // The page takes no arguments either, so there is no id from the request for it to read.
    expect(NotificationSettingsPage).toHaveLength(0)
  })

  it('mounts the preferences panel, which reads and writes over tRPC', async () => {
    panel.mockClear()
    await render()

    expect(panel).toHaveBeenCalledTimes(1)
  })

  it('names itself for the account rather than for the fleet', async () => {
    const markup = await render()

    expect(markup).toContain('Notifications')
    expect(markup).toContain('Account')
  })

  it('renders nothing at all for a session that is no longer active', async () => {
    session.mockReturnValueOnce({ user: { id: 'user-b', isActive: false } })

    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND')
    expect(notFound).toHaveBeenCalled()
  })

  it('renders nothing at all when there is no session', async () => {
    session.mockReturnValueOnce(null)

    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('calls no procedure for a session it has already refused', async () => {
    notificationSettings.mockClear()
    session.mockReturnValueOnce(null)

    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND')
    expect(notificationSettings).not.toHaveBeenCalled()
  })

  it('is dynamic, because its output is a function of the caller’s session', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
