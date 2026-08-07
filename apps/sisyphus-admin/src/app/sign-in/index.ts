/**
 * What the sign-in route publishes to the rest of the app.
 *
 * Almost nothing, and that is the shape it should keep. Next.js owns `page.tsx`, and the panel and
 * the server action beside it exist only for that page — they are deliberately **not** here, so a
 * screen elsewhere cannot grow its own sign-in form.
 *
 * What is shared is the vocabulary two other places need to agree with: the reason table, so a
 * caller can talk about an authentication failure without restating its wording, and the landing
 * path, so `app/page.tsx` sends an authenticated caller to exactly the screen a completed sign-in
 * lands on rather than to a second `/workflows` literal that can drift.
 */

export { AUTH_ERROR_REASONS, authErrorReason, REFUSAL_CAUSES } from './error-reason'
export type { AuthErrorReason } from './error-reason'

export {
  DEFAULT_REDIRECT_TARGET,
  REDIRECT_TARGET_FIELD,
  safeRedirectTarget,
} from './redirect-target'
