/**
 * The application shell (T149..T151, T156, FR-193, FR-194).
 *
 * The sidebar and the top bar are mounted in exactly one place — `src/app/(app)/layout.tsx` — and
 * a screen is inside the shell because of where its route file sits, not because it imported
 * anything from here. The one piece a screen does import is {@link PageHeader}, which is per-screen
 * by nature: the shell cannot know a page's title.
 *
 * `signOutAction` is deliberately **not** re-exported. It is a `'use server'` module and belongs to
 * the top bar; a barrel export would invite a second sign-out control somewhere else.
 */

export { isCurrentNavItem, NAV_SECTIONS, navSectionsForRole } from './nav-items'
export type { NavItem, NavSection } from './nav-items'

export { PageHeader } from './page-header'

export { Sidebar } from './sidebar'

export { TopBar } from './top-bar'
