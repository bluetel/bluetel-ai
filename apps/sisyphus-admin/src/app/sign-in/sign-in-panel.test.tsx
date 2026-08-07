import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AUTH_ERROR_REASONS } from './error-reason'
import { REDIRECT_TARGET_FIELD } from './redirect-target'
import { SignInPanel } from './sign-in-panel'

/**
 * The screen is asserted as markup rather than as a component tree, because the claims FR-195
 * makes are claims about what is on the page: one provider key and no picker, the design system
 * rather than the framework default, and a readable cause when there is one.
 *
 * Nothing here touches Auth.js — the action is a plain function, which is the whole point of the
 * panel taking it as a prop.
 */

const noop = async (): Promise<void> => {}

const render = (reason?: (typeof AUTH_ERROR_REASONS)[keyof typeof AUTH_ERROR_REASONS]) =>
  renderToStaticMarkup(
    <SignInPanel action={noop} redirectTo="/workflows/abc-123" reason={reason} />,
  )

describe('the sign-in screen, reached as a prompt', () => {
  it('offers one key for the one provider, and no picker to choose it with', () => {
    const markup = render()

    expect(markup).toContain('Continue with Google')
    expect(markup.match(/<button/g)).toHaveLength(1)
    // A picker would be a list, a select or a second provider. None of those exist here.
    expect(markup).not.toMatch(/<select|<ul|Choose a provider|Sign in with a different/i)
  })

  it('submits rather than links, so the round trip starts with a state change', () => {
    const markup = render()

    expect(markup).toContain('<form')
    expect(markup).toContain('type="submit"')
    expect(markup).not.toContain('<a ')
  })

  it('carries the requested destination through the round trip', () => {
    const markup = render()

    expect(markup).toContain(`name="${REDIRECT_TARGET_FIELD}"`)
    expect(markup).toContain('value="/workflows/abc-123"')
  })

  it('says nothing about an error when it was not reached as one', () => {
    const markup = render()

    expect(markup).not.toContain('Why you are seeing this')
    expect(markup).not.toContain('E_AUTH_')
    expect(markup).not.toContain('role="alert"')
  })

  it('is drawn in the design system, not the framework default (FR-021, FR-033)', () => {
    const markup = render()

    // The primitives' own classes: the card's hairline surface, the tinted header strip, the
    // panel-key button and the type tokens. A framework default page has none of these.
    expect(markup).toContain('border-hairline')
    expect(markup).toContain('bg-paper-2')
    expect(markup).toContain('shadow-keycap')
    expect(markup).toContain('type-heading')
    expect(markup).toContain('type-label-mono')
    // And no literal value smuggled in beside them (SC-015).
    expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b|\bp-\d|\btext-(sm|base|lg|xl)\b|rounded-full/i)
  })
})

describe('the sign-in screen, reached as an error return', () => {
  it('shows the cause and the code, with a next action rather than a dead end (FR-031)', () => {
    const markup = render(AUTH_ERROR_REASONS.refused)

    expect(markup).toContain('Why you are seeing this')
    expect(markup).toContain(AUTH_ERROR_REASONS.refused.code)
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Sign-in was refused')
  })

  it('still offers the key, so a refusal is not a dead end either (FR-196)', () => {
    const markup = render(AUTH_ERROR_REASONS.refused)

    expect(markup).toContain('Continue with Google')
    expect(markup).toContain(`name="${REDIRECT_TARGET_FIELD}"`)
  })

  it('keeps the chip idle: a refused sign-in is not a failed machine state (FR-025)', () => {
    const markup = render(AUTH_ERROR_REASONS.provider)

    expect(markup).toContain('data-state="idle"')
    expect(markup).not.toContain('text-rust-')
  })
})
