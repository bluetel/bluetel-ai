'use client'

import type { UserRole } from '@bluetel-ai/sisyphus-api/client'
import { FOCUS_RING } from '@sisyphus-admin/components/ui'
import { cn } from '@sisyphus-admin/lib/cn'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { isCurrentNavItem, type NavItem, navSectionsForRole } from './nav-items'

/**
 * The panel's persistent left sidebar (T150, FR-193, FR-201).
 *
 * A client component, because "which item am I on" is `usePathname()` and a server layout has no
 * pathname. The **role** is not read here: it arrives as a prop from `(app)/layout.tsx`, which
 * resolved the session on the server. That direction matters — a sidebar that fetched its own role
 * would be a second place the role is decided, and the one place that can be wrong on the client.
 *
 * ## The admin group is absent, not disabled
 *
 * `navSectionsForRole` filters, so for an engineer there is no Admin heading and no admin `<a>` in
 * the document at all. Rendering them disabled would advertise surfaces that answer `NOT_FOUND`,
 * which is the disclosure FR-190 exists to prevent (see `nav-items.ts`).
 *
 * ## Marking the current section without relying on colour
 *
 * FR-201 wants the mark legible to somebody who cannot see the accent. Three things carry it, and
 * only one of them is colour: `aria-current="page"` for assistive technology, a `▸` marker glyph
 * and a heavier weight for sighted readers, and the signal-coloured left rule on top of those. Turn
 * the colour off and the marker and the weight still say which item is current.
 *
 * The width is intrinsic — the labels set it — rather than a number, because the spacing scale has
 * eight named steps and none of them is a sidebar width. Below `md` the rail becomes a band across
 * the top, so a narrow viewport scrolls the page vertically rather than sideways.
 */
interface SidebarProps {
  /** The signed-in user's role, resolved on the server by the shell layout. */
  role: UserRole
}

/** Shared by every item, current or not, so marking one shifts nothing. */
const ITEM_BASE = [
  'type-body text-graphite',
  'flex items-center gap-tight whitespace-nowrap',
  'border-l border-transparent',
  'px-close py-tight rounded-sm',
  'transition-[background-color,border-color,color] duration-state ease-panel',
  'hover:bg-signal-wash hover:text-ink',
  FOCUS_RING,
]

const SidebarLink = ({ item, current }: { item: NavItem; current: boolean }) => (
  <li>
    <Link
      href={item.href}
      aria-current={current ? 'page' : undefined}
      data-current={current}
      className={cn(ITEM_BASE, current && 'border-signal text-ink font-semibold')}
    >
      <span aria-hidden="true" className="type-data-mono">
        {current ? '▸' : ' '}
      </span>
      <span>{item.label}</span>
    </Link>
  </li>
)

export const Sidebar = ({ role }: SidebarProps) => {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Primary"
      className="border-hairline bg-paper-2 p-close gap-section flex shrink-0 flex-col border-b md:border-b-0 md:border-r"
    >
      {navSectionsForRole(role).map((section) => (
        <div key={section.id} className="gap-tight flex flex-col">
          <p className="type-label-mono text-graphite px-close">{section.label}</p>
          <ul className="gap-hair flex flex-col">
            {section.items.map((item) => (
              <SidebarLink key={item.href} item={item} current={isCurrentNavItem(pathname, item)} />
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}
