import { Sidebar, TopBar } from '@sisyphus-admin/components/shell'
import { FOCUS_RING } from '@sisyphus-admin/components/ui'
import { env } from '@sisyphus-admin/env'
import { auth, isActiveSessionUser } from '@sisyphus-admin/lib/auth'
import { cn } from '@sisyphus-admin/lib/cn'
import { SIGN_IN_PATH } from '@sisyphus-admin/server'
import { TRPCReactProvider } from '@sisyphus-admin/trpc'
import { notFound, redirect } from 'next/navigation'
import type { ReactNode } from 'react'

/**
 * The application shell (T149, FR-193, R17).
 *
 * ## Why a route group and not a component
 *
 * `(app)` is parenthesised, so it contributes nothing to any URL: `/workflows` and `/admin/users`
 * are exactly where they were. What it changes is the default. A screen is inside the shell
 * **because of where its file sits**, so adding one puts it in the nav's world automatically, and
 * leaving it out is a deliberate act rather than a forgotten import. The failure the other design
 * produces has already happened here once: twelve screens shipped reachable only by typing a URL.
 *
 * `sign-in` stays outside the group — it is the one screen a signed-out visitor may render, and the
 * shell has nothing to show them.
 *
 * ## The session is resolved once, here
 *
 * Both the sidebar and the bar need it — the sidebar to decide which links exist at all, the bar to
 * say who is signed in — and resolving it twice would be two answers to one question. The two
 * refusals are the same two the fleet list already makes, for the same reasons: **no session** is a
 * redirect to sign in, because that caller has not been refused, they have not been asked; a
 * session that exists but is **not active** is `notFound`, because sign-in would refuse them too
 * and a loop is worse than a dead end (FR-175, FR-190).
 *
 * This is not the access control. Every admin screen still opens with `requireAdminPage()`, and
 * every read is still scoped inside the router. A layout that were load-bearing would be a second
 * place the rule had to be got right.
 *
 * ## Why the tRPC provider moved up here
 *
 * It used to be mounted by `AdminShell`, once per screen, because there was nowhere else for it.
 * The reasoning against the **root** layout still holds — the root is shared with `sign-in`, and a
 * provider there would make the panel's origin a value the build has to resolve — but this layout
 * is the authenticated group and is dynamic by definition, so the environment is still read inside
 * the request and now exactly once.
 *
 * ## Keyboard and landmarks (FR-201)
 *
 * A skip link is the first focusable thing in the document, so a keyboard user is not walked
 * through the whole nav on every page. The nav is a `<nav>`, the bar is a `<header>`, and the
 * screen is a `<main>` with the id the skip link targets. Below `md` the rail becomes a band across
 * the top and the column stacks, so a narrow viewport scrolls down rather than sideways.
 */
export const dynamic = 'force-dynamic'

/** The `<main>` element's id, and the skip link's target. One constant so they cannot drift. */
const MAIN_ID = 'main-content'

const AppLayout = async ({ children }: { children: ReactNode }) => {
  const user = (await auth())?.user

  if (user === undefined) redirect(SIGN_IN_PATH)
  if (!isActiveSessionUser(user)) notFound()

  return (
    <TRPCReactProvider siteUrl={env.NEXT_PUBLIC_SITE_URL}>
      <a
        href={`#${MAIN_ID}`}
        className={cn(
          'sr-only focus:not-sr-only',
          'focus:bg-paper focus:text-ink focus:border-hairline-hi',
          'focus:p-close focus:absolute focus:z-10 focus:rounded-sm focus:border',
          'type-label-button',
          FOCUS_RING,
        )}
      >
        Skip to content
      </a>

      <div className="flex min-h-screen flex-col md:flex-row">
        <Sidebar role={user.role} />

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar displayName={user.displayName} email={user.email} />

          <main
            id={MAIN_ID}
            className="p-gutter max-w-column gap-band mx-auto flex w-full flex-col"
          >
            {children}
          </main>
        </div>
      </div>
    </TRPCReactProvider>
  )
}

export default AppLayout
