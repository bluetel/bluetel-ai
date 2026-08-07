import { describe, expect, it } from 'vitest'

import * as signIn from './index'

describe('the sign-in route barrel', () => {
  it('publishes the vocabulary other routes share, and nothing else', () => {
    expect(Object.keys(signIn).sort()).toStrictEqual([
      'AUTH_ERROR_REASONS',
      'DEFAULT_REDIRECT_TARGET',
      'REDIRECT_TARGET_FIELD',
      'REFUSAL_CAUSES',
      'authErrorReason',
      'safeRedirectTarget',
    ])
  })

  it('does not publish the screen or the action, so no second sign-in form can be assembled', () => {
    expect(Object.keys(signIn)).not.toContain('SignInPanel')
    expect(Object.keys(signIn)).not.toContain('startGoogleSignIn')
  })
})
