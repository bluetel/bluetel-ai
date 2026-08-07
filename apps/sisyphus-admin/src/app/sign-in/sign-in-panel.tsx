import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FieldError,
  StateChip,
} from '@sisyphus-admin/components/ui'

import type { AuthErrorReason } from './error-reason'
import { REDIRECT_TARGET_FIELD } from './redirect-target'

/**
 * The sign-in screen's markup (T146, FR-195).
 *
 * ## One provider, so no picker
 *
 * `config.ts` registers Google and nothing else. Auth.js's stock page exists to choose between
 * providers and would render a list of one, which reads as though something is missing. There is a
 * single key, labelled with what pressing it does.
 *
 * ## Built from the primitives, and only from the primitives
 *
 * `Card` / `CardHeader` / `CardBody` give the border-led surface (FR-028), `Button` gives the panel
 * key (FR-029), and `FieldError` gives the one thing an error must be — a code plus a next action
 * rather than a dead end (FR-031). None of them is re-implemented here, and no class below names a
 * colour, a size or a radius: the layout utilities resolve to the named spacing steps in
 * `styles/theme.ts`, which is what keeps the token chain intact (FR-021, FR-033).
 *
 * The chip is the idle graphite one whatever happened, for the reason `NotFoundCard` gives: colour
 * in this system means machine state (FR-025), and a refused sign-in is not a failed run.
 *
 * ## Presentational
 *
 * It takes the action and the already-resolved destination as props and reads nothing itself — no
 * session, no query string, no environment. That is what lets it be rendered in a test without
 * Auth.js, and it is why the reason it displays cannot depend on anything but the reason it was
 * handed (FR-190; see `./error-reason.ts`).
 */

interface SignInPanelProps {
  /** The server action that starts the round trip. Injected so this file imports no auth. */
  readonly action: (form: FormData) => Promise<void>
  /** Where a completed sign-in lands. Already cleared by `./redirect-target.ts`. */
  readonly redirectTo: string
  /** Present only when the screen was reached as an authentication-error return. */
  readonly reason?: AuthErrorReason
}

export const SignInPanel = ({ action, redirectTo, reason }: SignInPanelProps) => (
  <main className="p-gutter flex min-h-screen items-center justify-center">
    <Card className="w-full max-w-prose">
      <CardHeader>
        <span>sisyphus</span>
        <StateChip>{reason === undefined ? 'sign in' : 'refused'}</StateChip>
      </CardHeader>
      <CardBody className="gap-section flex flex-col">
        <header className="gap-tight flex flex-col">
          <h1 className="type-heading text-ink">Sign in to the panel</h1>
          <p className="type-body text-graphite measure-prose">
            Sisyphus uses your organisation’s Google Workspace account. There is nothing else to
            choose and no password to keep.
          </p>
        </header>

        {reason === undefined ? null : (
          <section aria-labelledby="sign-in-reason" className="gap-tight flex flex-col">
            <h2 id="sign-in-reason" className="type-label-mono text-graphite">
              Why you are seeing this
            </h2>
            <p className="type-body text-ink measure-prose">{reason.summary}</p>
            <FieldError code={reason.code} action={reason.action} className="measure-prose" />
          </section>
        )}

        <form action={action}>
          <input type="hidden" name={REDIRECT_TARGET_FIELD} value={redirectTo} />
          <Button type="submit" variant="primary">
            Continue with Google
          </Button>
        </form>
      </CardBody>
    </Card>
  </main>
)
