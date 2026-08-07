import { Button } from '@sisyphus-admin/components/ui'

import { signOutAction } from './sign-out-action'

/**
 * The shell's top bar (T151, FR-194, SC-058).
 *
 * Two things, and they are the same thing said twice: **who you are signed in as**, and **the way
 * out**. Before this bar the panel displayed neither — a session could be started and not ended,
 * and no screen said whose session it was.
 *
 * The identity is passed in rather than resolved here. `(app)/layout.tsx` has already resolved the
 * session to decide whether the shell renders at all, and a bar that resolved it a second time
 * would be a second answer to the same question, reachable while the first was still in flight.
 *
 * ## Why sign-out is a form
 *
 * `signOut` runs on the server: it deletes the session row and clears the cookie. A form posting to
 * {@link signOutAction} is therefore the honest control — it works with JavaScript disabled, and it
 * cannot half-succeed the way a client handler that clears local state and then fails its request
 * can. It is in the bar rather than behind a menu because SC-058 asks that a user can end their
 * session from any screen **without leaving it to find the control**.
 */
interface TopBarProps {
  /** The signed-in user's display name, from the session.  */
  displayName: string
  /** Shown beneath the name: two people share a first name, nobody shares an address. */
  email: string
}

export const TopBar = ({ displayName, email }: TopBarProps) => (
  <header className="border-hairline p-close gap-close flex items-center justify-between border-b">
    <div className="gap-hair flex flex-col">
      <p className="type-label-mono text-graphite">Signed in</p>
      <p className="type-body text-ink">
        {displayName} <span className="type-data-mono text-graphite">{email}</span>
      </p>
    </div>

    <form action={signOutAction}>
      <Button type="submit" variant="secondary">
        Sign out
      </Button>
    </form>
  </header>
)
