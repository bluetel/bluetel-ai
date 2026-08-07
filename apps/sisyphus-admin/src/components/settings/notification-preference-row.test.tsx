import type { ReactNode } from 'react'
import { isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { NotificationPreferenceRow } from './notification-preference-row'
import type { NotificationPreference } from './preference-readouts'
import { toPreferenceReadouts } from './preference-readouts'

const readouts = (overrides: Partial<NotificationPreference> = {}) =>
  toPreferenceReadouts({
    event: 'workflow_succeeded',
    enabled: true,
    explicit: false,
    ...overrides,
  })

const render = (overrides: Partial<NotificationPreference> = {}, props = {}) =>
  renderToStaticMarkup(
    <NotificationPreferenceRow readouts={readouts(overrides)} onChange={vi.fn()} {...props} />,
  )

/** The first `onClick` in a returned element tree, or `undefined` when the row offers no control. */
const findClickHandler = (node: ReactNode): (() => void) | undefined => {
  if (Array.isArray(node)) {
    return node.map((child) => findClickHandler(child as ReactNode)).find((found) => found)
  }

  if (!isValidElement(node)) return undefined

  const props = node.props as { onClick?: () => void; children?: ReactNode }

  return props.onClick ?? findClickHandler(props.children)
}

/** Press the row's control, failing loudly rather than silently passing if it has none. */
const pressControl = (node: ReactNode): void => {
  const handler = findClickHandler(node)

  expect(handler).toBeTypeOf('function')
  handler?.()
}

describe('a notification preference row', () => {
  it('says what will happen and where that setting came from (FR-138)', () => {
    const markup = render({ enabled: true, explicit: false })

    expect(markup).toContain('notifying')
    expect(markup).toContain('default')
  })

  it('does not present a default as a choice the caller made', () => {
    expect(render({ enabled: true, explicit: false })).not.toContain('your choice')
  })

  it('marks a stored decision as one, so the two are distinguishable on the screen', () => {
    const chosen = render({ enabled: true, explicit: true })

    expect(chosen).toContain('your choice')
    expect(chosen).not.toContain('>default<')
  })

  it('offers a control labelled with the change, named by the event it changes', () => {
    const markup = render({ enabled: true })

    expect(markup).toContain('Mute this event')
    expect(markup).toContain('aria-label="Mute this event: Run succeeded"')
  })

  it('offers the opposite change on a muted event', () => {
    expect(render({ enabled: false, explicit: true })).toContain('Notify me about this')
  })

  it('ties the control to the sentence explaining the event', () => {
    const markup = render()

    expect(markup).toContain('id="workflow_succeeded-detail"')
    expect(markup).toContain('aria-describedby="workflow_succeeded-detail"')
  })

  it('reports its own in-flight state rather than looking idle (FR-023, FR-201)', () => {
    const markup = render({}, { startedAt: Date.now() })

    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('Saving')
    // The idle control is gone while the change is in flight, so a second press cannot race it.
    expect(markup).not.toContain('Mute this event')
  })

  it('renders a refusal with a code and a next action, never a dead end (FR-031)', () => {
    const markup = render({}, { error: { code: 'E_NOPE', action: 'Try again in a moment.' } })

    expect(markup).toContain('E_NOPE')
    expect(markup).toContain('Try again in a moment.')
    expect(markup).toContain('role="alert"')
  })

  it('asks for the opposite of the value it holds, rather than for a toggle', () => {
    // There is no testing library in this app, so the handler is found in the element tree the
    // component returns and called directly. What is being asserted is the *argument*: a row that
    // called back with "flip it" would leave the panel guessing at a value it can read.
    const onChange = vi.fn()

    pressControl(NotificationPreferenceRow({ readouts: readouts({ enabled: true }), onChange }))
    expect(onChange).toHaveBeenCalledWith(false)

    const enabling = vi.fn()
    pressControl(
      NotificationPreferenceRow({ readouts: readouts({ enabled: false }), onChange: enabling }),
    )
    expect(enabling).toHaveBeenCalledWith(true)
  })

  it('is operable from the keyboard with a visible focus ring (FR-201)', () => {
    // The control is a real `<button>` from the primitive set rather than a clickable div, so it is
    // in the tab order and carries the one shared ring.
    const markup = render()

    expect(markup).toContain('<button')
    expect(markup).toContain('focus-ring')
  })

  it('writes no literal colour, size or radius (SC-015)', () => {
    const markup = render()

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="[^"]*\d+(px|rem)/)
  })
})
