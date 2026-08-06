import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { UserActionForm } from './user-action-form'
import { userAction } from './user-actions'
import { LAST_ACTIVE_ADMIN_ERROR } from './user-change-outcome'

const noop = () => undefined

const render = (props: Partial<Parameters<typeof UserActionForm>[0]> = {}) =>
  renderToStaticMarkup(
    <UserActionForm
      action={userAction('deactivate')}
      reason=""
      onReasonChange={noop}
      onConfirm={noop}
      onCancel={noop}
      {...props}
    />,
  )

describe('UserActionForm', () => {
  it('states the consequence before the confirm control, not after the change', () => {
    const markup = render()

    expect(markup).toContain('Nothing is deleted')
    expect(markup.indexOf('Nothing is deleted')).toBeLessThan(markup.indexOf('Confirm'))
  })

  it('labels the reason field above the control, never as a placeholder', () => {
    const markup = render()

    expect(markup).toContain('Reason (optional)')
    expect(markup).not.toContain('placeholder="Reason (optional)"')
    expect(markup.indexOf('<label')).toBeLessThan(markup.indexOf('<input'))
  })

  it('names the change on the confirm button, in sentence case', () => {
    expect(render()).toContain('Confirm: deactivate')
    expect(render()).not.toContain('CONFIRM')
  })

  it('offers a cancel that is quiet, so the destructive control is the only weighted one', () => {
    const markup = render()

    expect(markup).toContain('Cancel')
    expect(markup).not.toContain('bg-signal ')
  })

  it('renders the never-zero-admins refusal as a field error with its code and next action', () => {
    const markup = render({ error: LAST_ACTIVE_ADMIN_ERROR })

    expect(markup).toContain('E_LAST_ACTIVE_ADMIN')
    expect(markup).toContain('Grant the admin role to another active user first')
    expect(markup).toContain('role="alert"')
  })

  it('binds that refusal to the control it belongs to, rather than floating it away', () => {
    const markup = render({ error: LAST_ACTIVE_ADMIN_ERROR })
    const describedBy = /aria-describedby="([^"]+)"/.exec(markup)?.[1]

    expect(describedBy).toBeDefined()
    expect(markup).toContain(`id="${String(describedBy)}"`)
    expect(markup).toContain('data-state="invalid"')
  })

  it('replaces the confirm label with a live readout while in flight, and shows no spinner', () => {
    const markup = render({ startedAt: 1000 })

    expect(markup).toContain('Deactivating 0:00')
    expect(markup).toContain('aria-busy="true"')
    expect(markup).not.toMatch(/spinner|animate-spin/)
  })

  it('locks the reason and the cancel while the change is in flight', () => {
    const markup = render({ startedAt: 1000 })

    expect(markup.match(/disabled/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('carries the action’s own weight, so a withdrawal reads as one', () => {
    expect(render({ action: userAction('deactivate') })).toContain('text-rust')
    expect(render({ action: userAction('reactivate') })).not.toContain('border-rust')
  })

  it('carries no literal colour, size or radius', () => {
    expect(render()).not.toMatch(/#[0-9a-fA-F]{3,8}|\d+(?:px|rem)/)
  })
})
