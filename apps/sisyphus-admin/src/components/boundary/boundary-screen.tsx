import type { ReactNode } from 'react'

interface BoundaryScreenProps {
  readonly children: ReactNode
}

/**
 * The page column for a boundary that renders **outside** the application shell (FR-197).
 *
 * ## Why this exists at all
 *
 * `src/app/(app)/layout.tsx` opens the `<main>` landmark and sets the column for every
 * authenticated screen, and the two boundaries inside that group inherit both. The two at the root
 * of `src/app` do not: they are siblings of the group, reachable by a signed-out visitor typing a
 * URL and by the group's own layout refusing, and the only thing above them is the root layout,
 * which is `<html><body>` and the two fonts.
 *
 * Without this they would be a card floating at the top-left of an unpadded page — styled, but not
 * *laid out*, which is half of what "never the framework's unstyled default" means. So they get the
 * same landmark and the same column the shell would have given them, and nothing else: no sidebar
 * and no top bar, because both need a session and the caller may not have one.
 *
 * `id="main-content"` is not set here. That id belongs to the shell's `<main>` and to the skip link
 * that targets it; there is no skip link on these screens, because there is nothing to skip.
 */
export const BoundaryScreen = ({ children }: BoundaryScreenProps) => (
  <main className="p-gutter max-w-column gap-band mx-auto flex min-h-screen w-full flex-col">
    {children}
  </main>
)
