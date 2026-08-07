/**
 * Where a completed sign-in lands, resolved from an untrusted `callbackUrl` (T146, FR-196).
 *
 * Auth.js puts `?callbackUrl=` on the sign-in page so an operator who asked for `/workflows/abc`
 * while signed out arrives at `/workflows/abc` rather than at a generic landing screen. That
 * parameter is written by whoever composed the URL, which makes this a redirect the attacker
 * partly controls — the classic shape of an open redirect, and a good one to have on a sign-in
 * page, because the victim has just typed their password into something that looked right.
 *
 * The defence is an allowlist by shape rather than a blocklist of tricks: the value has to be a
 * path on this panel and nothing else. Anything that could name another origin — a scheme, a
 * protocol-relative `//host`, a backslash a browser will normalise into a slash — resolves to the
 * default instead of being repaired. Auth.js applies its own same-origin `redirect` callback after
 * this, so it is the second lock and not the only one.
 */

/** Where a sign-in goes when nothing valid was asked for. The panel's own landing screen. */
export const DEFAULT_REDIRECT_TARGET = '/workflows'

/** The hidden form field the sign-in screen carries the resolved target in. */
export const REDIRECT_TARGET_FIELD = 'redirectTo'

/**
 * A path on this panel: one leading slash, not followed by another slash or a backslash, and no
 * whitespace anywhere. The whitespace rule is not tidiness — a browser strips a raw tab or newline
 * out of a URL before it parses it, so `/[tab]/evil.example.com` is another way of writing
 * `//evil.example.com` and has to be refused as one.
 */
const SAME_SITE_PATH = /^\/(?![/\\])\S*$/

/**
 * Resolve the post-sign-in destination.
 *
 * @param value - The `callbackUrl` query parameter or the submitted form field. Untrusted, and any
 *   shape at all, because a query string is whatever was typed.
 * @returns A path on this panel — the requested one when it is safe, {@link DEFAULT_REDIRECT_TARGET}
 *   otherwise. Never a value that could leave the origin, and never `undefined`: a caller that had
 *   to decide what to do with "no target" is a caller that can forget to.
 */
export const safeRedirectTarget = (value: unknown): string => {
  const candidate = firstValue(value)

  if (!SAME_SITE_PATH.test(candidate)) return DEFAULT_REDIRECT_TARGET

  // Sending someone back to the screen they just completed is a loop that looks like a failure.
  if (candidate === '/' || candidate.startsWith('/sign-in')) return DEFAULT_REDIRECT_TARGET

  return candidate
}

/** Total over the shapes a query parameter or a form field can arrive as. */
const firstValue = (value: unknown): string => {
  if (typeof value === 'string') return value.trim()

  if (Array.isArray(value)) {
    const [first] = value as readonly unknown[]
    return typeof first === 'string' ? first.trim() : ''
  }

  return ''
}
