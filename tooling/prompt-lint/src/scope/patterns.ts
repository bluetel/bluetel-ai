/**
 * The declared set of AI-authored artifacts (FR-001, FR-002) — one table, so the set
 * is inspectable and its blind spots are discoverable. Nothing here is heuristic: a
 * file is in scope because it is listed, not because it looked like instructions.
 *
 * `specs/**` is deliberately absent (research R1). A `spec.md` is a record, not
 * something an agent reads and acts on at runtime, and gating records has a concrete
 * cost with no matching benefit — `specs/004-…/checklists/requirements.md` contains
 * the literal line `- [x] No [NEEDS CLARIFICATION] markers remain`, which a
 * placeholder rule would report forever.
 */

/** The named subsets `--scope=` accepts. */
export type ScopeSubset = 'catalog' | 'installed' | 'guidance' | 'speckit'

export interface ArtifactLocation {
  /** Repo-relative glob, POSIX separators. `*` stays within a segment; `**` crosses them. */
  glob: string
  /** Which `--scope=` subsets include this location. */
  subsets: ScopeSubset[]
  /** Why it is in the declared set. FR-001 requires the set be explainable, not just listed. */
  reason: string
}

export const SUBSET_NAMES: readonly ScopeSubset[] = ['catalog', 'installed', 'guidance', 'speckit']

export const ARTIFACT_LOCATIONS: readonly ArtifactLocation[] = [
  {
    glob: 'tooling/skills/catalog/*/SKILL.md',
    subsets: ['catalog'],
    reason: 'the published skill body — executed verbatim by every project that installs it',
  },
  {
    glob: 'tooling/skills/catalog/*/skill.meta',
    subsets: ['catalog'],
    reason: 'the installer reads this to list, install and version a skill',
  },
  {
    glob: 'tooling/skills/catalog/*/references/**/*.md',
    subsets: ['catalog'],
    reason: 'read by a skill mid-procedure, so a broken one silently drops a step',
  },
  {
    glob: '.agents/skills/*/**/*.md',
    subsets: ['installed'],
    reason: 'this repository’s installed copy — compared against the catalog for drift',
  },
  {
    glob: '.claude/skills/*/SKILL.md',
    subsets: ['installed'],
    reason: 'the pointer an agent reads first when deciding whether a skill applies',
  },
  {
    glob: 'AGENTS.md',
    subsets: ['guidance'],
    reason: 'loaded at the start of every agent run',
  },
  {
    glob: 'CLAUDE.md',
    subsets: ['guidance'],
    reason: 'loaded at the start of every agent run',
  },
  {
    glob: '.claude/rules/*.md',
    subsets: ['guidance'],
    reason: 'project rules that override default behaviour',
  },
  {
    glob: '.agents/*.md',
    subsets: ['guidance'],
    reason: 'shared agent guidance, including the remote workflow instructions',
  },
  {
    glob: '.specify/templates/*.md',
    subsets: ['speckit'],
    reason: 'the templates every Spec Kit command fills in',
  },
  {
    glob: '.specify/memory/constitution.md',
    subsets: ['speckit'],
    reason: 'the gate every plan checks itself against',
  },
]

/**
 * Compile one glob segment-wise. `**` matches any number of segments including zero;
 * `*` matches within a single segment and never crosses a `/`.
 */
const globToRegExp = (glob: string): RegExp => {
  const pattern = glob
    .split('/')
    .map((segment) => {
      if (segment === '**') return '(?:.*)'
      return segment
        .split('*')
        .map((literal) => literal.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*')
    })
    .join('/')
    // A `**` segment must be able to match zero segments, which means swallowing the
    // separator that would otherwise be left behind: `a/**/b.md` has to match `a/b.md`.
    .replace(/\/\(\?:\.\*\)\//g, '/(?:.*/)?')
  return new RegExp(`^${pattern}$`)
}

const COMPILED = ARTIFACT_LOCATIONS.map((location) => ({
  location,
  matcher: globToRegExp(location.glob),
}))

/** Does this repo-relative path match this glob? Exported for its own suite. */
export const matchesGlob = (glob: string, path: string): boolean => globToRegExp(glob).test(path)

/** The location a path belongs to, or null when the path is not a declared artifact. */
export const locationOf = (path: string, subset?: ScopeSubset): ArtifactLocation | null => {
  for (const { location, matcher } of COMPILED) {
    if (subset !== undefined && !location.subsets.includes(subset)) continue
    if (matcher.test(path)) return location
  }
  return null
}

/** Is this path in the declared set — optionally narrowed to one named subset? */
export const isDeclaredArtifact = (path: string, subset?: ScopeSubset): boolean =>
  locationOf(path, subset) !== null

/** Is `name` one of the subsets `--scope=` accepts? Unknown names are exit 2, not a silent pass. */
export const isScopeSubset = (name: string): name is ScopeSubset =>
  (SUBSET_NAMES as readonly string[]).includes(name)
