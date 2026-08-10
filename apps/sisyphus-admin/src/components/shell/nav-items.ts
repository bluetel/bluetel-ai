import type { UserRole } from '@bluetel-ai/sisyphus-api/client'

/**
 * The sidebar's nav model, as data rather than as JSX (T150, FR-193, FR-190).
 *
 * It is a separate module from `sidebar.tsx` for one reason: **which links a role is shown is a
 * rule, and a rule that lives inside a component is a rule nothing can test without rendering.**
 * Here it is a list and a filter, so the property that matters — that an engineer is never handed a
 * link to a surface that will answer `NOT_FOUND` — is a pure function with its own suite.
 *
 * ## Absent, not disabled
 *
 * {@link navSectionsForRole} **removes** every admin entry for a non-admin. A disabled link would
 * still say "this exists and you may not have it", which is the disclosure FR-190 spends the whole
 * API surface avoiding: an out-of-scope read and a nonexistent one answer identically, and a nav
 * that advertises the difference undoes that from the outside.
 *
 * ## Why `adminOnly` sits on the item and not only on the group
 *
 * FR-193 lists Fleet alongside Workflows and Needs attention, but the fleet oversight screen is
 * `/admin/fleet` and opens with `requireAdminPage()`. Showing an engineer a link that answers
 * `NOT_FOUND` would break the same clause of FR-193 two sentences later, so the flag is per item
 * and Fleet carries it. The grouping is presentational; the flag is the rule.
 */

/** One link in the sidebar. */
export interface NavItem {
  /** Where the link goes. May carry a fragment; {@link NavItem.match} is what decides "current". */
  readonly href: string
  readonly label: string
  /**
   * The pathname this item is "on". Separate from {@link NavItem.href} because two entries can
   * name two surfaces that ship on one screen — workspaces and execution profiles both live at
   * `/admin/profiles` — and the fragment must not stop the item from being marked current.
   */
  readonly match: string
  /** Filtered out entirely for a non-admin. Never rendered disabled. */
  readonly adminOnly: boolean
}

/** A titled run of links. */
export interface NavSection {
  /** Stable key, and the value a test can name a section by without matching prose. */
  readonly id: string
  /** The `label-mono` heading above the run. */
  readonly label: string
  readonly items: readonly NavItem[]
}

/** The whole nav, before any role is applied. */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: 'fleet',
    label: 'Fleet',
    items: [
      { href: '/workflows', label: 'Workflows', match: '/workflows', adminOnly: false },
      { href: '/workflows/new', label: 'Launch a run', match: '/workflows/new', adminOnly: false },
      {
        href: '/workflows/needs-attention',
        label: 'Needs attention',
        match: '/workflows/needs-attention',
        adminOnly: false,
      },
      { href: '/admin/fleet', label: 'Oversight', match: '/admin/fleet', adminOnly: true },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    items: [
      { href: '/admin/bundles', label: 'Setup bundles', match: '/admin/bundles', adminOnly: true },
      {
        href: '/admin/profiles#workspaces',
        label: 'Workspaces',
        match: '/admin/profiles',
        adminOnly: true,
      },
      {
        href: '/admin/profiles',
        label: 'Execution profiles',
        match: '/admin/profiles',
        adminOnly: true,
      },
      {
        href: '/admin/integrations',
        label: 'Integrations',
        match: '/admin/integrations',
        adminOnly: true,
      },
      /**
       * The three agent-credential surfaces (003/FR-053, FR-060, FR-193).
       *
       * Three entries rather than one screen with tabs, because they answer three different
       * questions and only one of them is asked routinely. The pool view is the one an
       * administrator opens to decide whether to buy another seat (FR-053); the registry is where
       * a seat is added or recovered; groups is configuration that is edited once and then left.
       * Folding them together would put the daily question behind a tab.
       *
       * All three are `adminOnly`, and more strictly so than the rest of this group: 003's access
       * scoping is deliberately narrower than 002's profile-scoped model — a credential is
       * platform infrastructure and its state reveals nothing an engineer can act on. The one
       * credential fact an engineer sees is on their own workflow, that it is waiting for a seat
       * and for how long, and that is reached through the existing workflow scoping rather than
       * through any of these screens.
       */
      {
        href: '/admin/credentials/pool',
        label: 'Credential pool',
        match: '/admin/credentials/pool',
        adminOnly: true,
      },
      {
        href: '/admin/credentials',
        label: 'Agent credentials',
        match: '/admin/credentials',
        adminOnly: true,
      },
      {
        href: '/admin/credentials/groups',
        label: 'Credential groups',
        match: '/admin/credentials/groups',
        adminOnly: true,
      },
      { href: '/admin/users', label: 'Users', match: '/admin/users', adminOnly: true },
      { href: '/admin/audit', label: 'Audit', match: '/admin/audit', adminOnly: true },
    ],
  },
  {
    /**
     * The caller's own account (T157, FR-138, FR-193).
     *
     * `adminOnly: false`, and last rather than inside the Admin group, because a notification
     * preference is about the person reading it: the procedures behind the screen are
     * `authedProcedure`, an engineer is exactly who needs it, and filing it under Admin would hide
     * it from everyone it is for. A screen reachable only by typing its URL is what FR-193 forbids,
     * and this one had been exactly that.
     */
    id: 'account',
    label: 'Account',
    items: [
      {
        href: '/settings/notifications',
        label: 'Notifications',
        match: '/settings/notifications',
        adminOnly: false,
      },
    ],
  },
]

/**
 * The nav a role may see.
 *
 * @param role - The signed-in user's role.
 * @returns The sections with every out-of-role item removed, and a section left with no items
 *   removed with them — an empty "Admin" heading would advertise the group it was meant to hide.
 */
export const navSectionsForRole = (role: UserRole): readonly NavSection[] =>
  NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.adminOnly || role === 'admin'),
  })).filter((section) => section.items.length > 0)

/**
 * Whether an item is the one the current route is on.
 *
 * Exact match rather than prefix match. `/workflows` is a prefix of `/workflows/new`, so a prefix
 * rule would light both up on the launch screen and the mark would stop meaning "you are here".
 * A detail screen such as `/workflows/{id}` therefore marks nothing, which is honest: it is not one
 * of the sections.
 *
 * @param pathname - The current route, from `usePathname()`.
 * @param item - The item being rendered.
 */
export const isCurrentNavItem = (pathname: string, item: NavItem): boolean =>
  pathname === item.match
