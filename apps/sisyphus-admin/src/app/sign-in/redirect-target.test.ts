import { describe, expect, it } from 'vitest'

import { DEFAULT_REDIRECT_TARGET, safeRedirectTarget } from './redirect-target'

/**
 * The interesting cases are all refusals. A sign-in page that forwards to whatever `callbackUrl`
 * says is an open redirect on the one screen where it does the most damage, so the table below is
 * the list of ways of writing "somewhere else" that a browser will happily follow.
 */
describe('safeRedirectTarget', () => {
  it('keeps the screen the operator actually asked for', () => {
    expect(safeRedirectTarget('/workflows/abc-123')).toBe('/workflows/abc-123')
    expect(safeRedirectTarget('/admin/users?role=admin')).toBe('/admin/users?role=admin')
    expect(safeRedirectTarget(['/admin/audit'])).toBe('/admin/audit')
  })

  it('falls back when nothing was asked for', () => {
    expect(safeRedirectTarget(undefined)).toBe(DEFAULT_REDIRECT_TARGET)
    expect(safeRedirectTarget('')).toBe(DEFAULT_REDIRECT_TARGET)
    expect(safeRedirectTarget([])).toBe(DEFAULT_REDIRECT_TARGET)
    expect(safeRedirectTarget({ callbackUrl: '/workflows' })).toBe(DEFAULT_REDIRECT_TARGET)
  })

  it.each([
    ['an absolute URL', 'https://evil.example.com/'],
    ['a scheme-only prefix', 'http://evil.example.com'],
    ['a protocol-relative host', '//evil.example.com/workflows'],
    ['a backslash a browser normalises to a slash', '/\\evil.example.com'],
    ['a double backslash', '\\\\evil.example.com'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,<script>alert(1)</script>'],
    ['a bare path with no leading slash', 'evil.example.com'],
    ['a tab a browser strips before parsing', '/\t/evil.example.com'],
    ['a newline a browser strips before parsing', '/\n/evil.example.com'],
  ])('refuses %s rather than trying to repair it', (_case, value) => {
    expect(safeRedirectTarget(value)).toBe(DEFAULT_REDIRECT_TARGET)
  })

  it('does not send a completed sign-in back to the sign-in screen', () => {
    expect(safeRedirectTarget('/sign-in')).toBe(DEFAULT_REDIRECT_TARGET)
    expect(safeRedirectTarget('/sign-in?error=AccessDenied')).toBe(DEFAULT_REDIRECT_TARGET)
    // `/` redirects to the workflow list anyway; going straight there saves a round trip.
    expect(safeRedirectTarget('/')).toBe(DEFAULT_REDIRECT_TARGET)
  })
})
