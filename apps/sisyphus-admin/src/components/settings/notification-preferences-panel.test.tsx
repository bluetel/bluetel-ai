import { NOTIFICATION_EVENTS } from '@bluetel-ai/sisyphus-api/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

/**
 * The panel holds a query and a mutation, so the tRPC hooks are stubbed and the component is
 * rendered to markup. What is asserted here is what only the wiring can get wrong: that the list
 * is the platform's whole vocabulary rather than the caller's stored rows, that a default is never
 * presented as a decision, and that the three states FR-201 asks for are all reachable.
 *
 * The shaping itself is asserted in `preference-readouts.test.ts` and the row in its own file.
 */

const useQuery = vi.fn((): unknown => ({ data: undefined, error: null, isPending: true }))
const mutate = vi.fn()
const invalidate = vi.fn()

vi.mock('@sisyphus-admin/trpc', () => ({
  api: {
    useUtils: () => ({ workflow: { notificationPreferences: { invalidate } } }),
    workflow: {
      notificationPreferences: { useQuery },
      setNotificationPreference: { useMutation: () => ({ mutate }) },
    },
  },
}))

const { NotificationPreferencesPanel } = await import('./notification-preferences-panel')

const everyEvent = (explicit: boolean) =>
  NOTIFICATION_EVENTS.map((event) => ({ event, enabled: true, explicit }))

const render = (answer: unknown): string => {
  useQuery.mockReturnValue(answer)
  return renderToStaticMarkup(<NotificationPreferencesPanel />)
}

const settled = (data: unknown): unknown => ({ data, error: null, isPending: false })

describe('the notification preferences panel', () => {
  it('says it is reading rather than showing an empty list (FR-201)', () => {
    const markup = render({ data: undefined, error: null, isPending: true })

    expect(markup).toContain('reading your preferences')
    expect(markup).toContain('reading')
  })

  it('offers one control for every event the platform can send (FR-138)', () => {
    const markup = render(settled(everyEvent(false)))

    for (const event of NOTIFICATION_EVENTS) {
      expect(markup).toContain(`${event}-detail`)
    }
    expect(markup.match(/<button/g)).toHaveLength(NOTIFICATION_EVENTS.length)
  })

  it('states that an untouched screen is defaults rather than a configuration (FR-138)', () => {
    const markup = render(settled(everyEvent(false)))

    expect(markup).toContain(`defaults ${String(NOTIFICATION_EVENTS.length)}`)
    expect(markup).toContain('not a choice you made')
    expect(markup).not.toContain('your choice')
  })

  it('stops claiming defaults once every event carries a decision', () => {
    const markup = render(settled(everyEvent(true)))

    expect(markup).toContain('your choice')
    expect(markup).toContain('Nothing here is a default')
  })

  it('renders a refusal with a code and a next action (FR-031, FR-201)', () => {
    const markup = render({
      data: undefined,
      error: { data: { code: 'INTERNAL_SERVER_ERROR' } },
      isPending: false,
    })

    expect(markup).toContain('E_UNEXPECTED')
    expect(markup).toContain('role="alert"')
  })

  it('says so if the vocabulary is empty, rather than looking like a silent configuration', () => {
    const markup = render(settled([]))

    expect(markup).toContain('no notification events')
    expect(markup).not.toContain('<button')
  })

  it('names Slack as the only channel, so the screen does not imply email', () => {
    expect(render(settled(everyEvent(false)))).toContain('Slack direct message')
  })

  it('writes no literal colour, size or radius (SC-015)', () => {
    const markup = render(settled(everyEvent(false)))

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="[^"]*\d+(px|rem)/)
  })
})
