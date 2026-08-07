import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { RevokeConfirmation } from './revoke-confirmation'

const noop = () => undefined

const render = (props: Partial<Parameters<typeof RevokeConfirmation>[0]> = {}) =>
  renderToStaticMarkup(
    <RevokeConfirmation holder="An Engineer" onConfirm={noop} onCancel={noop} {...props} />,
  )

describe('RevokeConfirmation', () => {
  it('states the cascade before the confirm control, not after the revocation', () => {
    const markup = render()

    expect(markup).toContain('Watches they hold on this profile')
    expect(markup.indexOf('Watches they hold')).toBeLessThan(markup.indexOf('Confirm: revoke'))
  })

  it('names the holder', () => {
    expect(render()).toContain('An Engineer')
  })

  it('says which watches survive and that in-flight work is untouched', () => {
    const markup = render()

    expect(markup).toContain('own or initiated')
    expect(markup).toContain('already in flight are untouched')
  })

  it('says the grant is stamped rather than deleted, so the trail is not feared lost', () => {
    expect(render()).toContain('not deleted')
  })

  it('weights the confirm as a withdrawal and the escape as quiet', () => {
    const markup = render()

    expect(markup).toContain('text-rust')
    expect(markup).toContain('Cancel')
  })

  it('holds no primary button, because this is a destructive confirmation', () => {
    expect(render()).not.toContain('bg-signal ')
  })

  it('renders a refusal with its code and next action, never as a bare message', () => {
    const markup = render({
      error: { code: 'E_GRANT_TARGET_NOT_FOUND', action: 'Reload the access list and pick again.' },
    })

    expect(markup).toContain('E_GRANT_TARGET_NOT_FOUND')
    expect(markup).toContain('Reload the access list and pick again.')
    expect(markup).toContain('role="alert"')
  })

  it('never says permission, which would confirm the target exists', () => {
    expect(render().toLowerCase()).not.toContain('permission')
  })

  it('replaces the confirm label with a live readout while in flight, and shows no spinner', () => {
    const markup = render({ startedAt: 1000 })

    expect(markup).toContain('Revoking 0:00')
    expect(markup).toContain('aria-busy="true"')
    expect(markup).not.toMatch(/spinner|animate-spin/)
  })

  it('carries no literal colour, size or radius', () => {
    expect(render()).not.toMatch(/#[0-9a-fA-F]{3,8}|\d+(?:px|rem)/)
  })
})
