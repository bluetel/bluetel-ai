import { TRPCReactProvider } from '@sisyphus-admin/trpc'
import type { ReactNode } from 'react'

interface AdminShellProps {
  /** Absolute origin of the panel, read from the validated environment by the page that mounts this. */
  siteUrl: string
  /** The `label-mono` eyebrow above the title — where in the console the operator is. */
  eyebrow: string
  title: string
  /** One sentence of what this page is for. Set to the prose measure, not the column width. */
  summary: string
  children: ReactNode
}

/**
 * The frame every admin page renders inside: the tRPC client, and the page's single column.
 *
 * The provider is mounted here rather than in the root layout on purpose. Everything under
 * `/admin` is session-gated and dynamic, whereas the root layout is shared with pages that are
 * static — and a provider there would make the panel's origin a value the *build* has to resolve.
 * Mounting it in the shell keeps the environment read inside the request.
 *
 * The column is `1120px` (`max-w-column`) with a `gutter` margin, per DESIGN.md → Layout: the panel
 * is a document, not a dashboard grid.
 */
export const AdminShell = ({ siteUrl, eyebrow, title, summary, children }: AdminShellProps) => (
  <TRPCReactProvider siteUrl={siteUrl}>
    <main className="p-gutter max-w-column gap-band mx-auto flex flex-col">
      <header className="gap-tight flex flex-col">
        <p className="type-label-mono text-graphite">{eyebrow}</p>
        <h1 className="type-heading text-ink">{title}</h1>
        <p className="type-body text-graphite measure-prose">{summary}</p>
      </header>
      {children}
    </main>
  </TRPCReactProvider>
)
