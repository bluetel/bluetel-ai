interface PageHeaderProps {
  /** The `label-mono` eyebrow above the title — where in the console the operator is. */
  eyebrow: string
  title: string
  /** One sentence of what this page is for. Set to the prose measure, not the column width. */
  summary: string
}

/**
 * The heading block every screen opens with (T156, FR-193).
 *
 * ## What this used to be
 *
 * It was `AdminShell`, and it was the closest thing the panel had to chrome: it mounted the tRPC
 * provider, opened the `<main>` landmark and set the page column, because until `(app)/layout.tsx`
 * existed there was nowhere else for any of that to live. All three now belong to the shell, which
 * wraps every authenticated screen by **route group** rather than by each page remembering to
 * import a wrapper. Leaving them here would have made this a second shell nested inside the first:
 * two `<main>` elements in one document, two providers, and a column inside a column.
 *
 * What is left is the part that is genuinely per-screen — the eyebrow, the title, and the one
 * sentence saying what the screen is for — and the name now says so. It was never really admin-only
 * either: `/workflows`, `/workflows/new` and both run detail screens render it, and always did.
 *
 * It takes no `children`. A header that wrapped the page would be framing, and framing is the
 * layout's job now; a screen renders this and then its panels as siblings inside the `<main>` the
 * shell opened.
 *
 * The element is a `<header>`, and because it sits inside `<main>` it is a section heading rather
 * than a second banner landmark — the shell's top bar is the banner.
 */
export const PageHeader = ({ eyebrow, title, summary }: PageHeaderProps) => (
  <header className="gap-tight flex flex-col">
    <p className="type-label-mono text-graphite">{eyebrow}</p>
    <h1 className="type-heading text-ink">{title}</h1>
    <p className="type-body text-graphite measure-prose">{summary}</p>
  </header>
)
