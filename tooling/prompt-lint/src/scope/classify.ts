/**
 * Path → `ArtifactKind`: the classification that decides which rules apply (FR-003).
 *
 * A file that matched a declared location but fits no kind classifies as
 * `unclassified` and is **reported** (FR-004), never skipped. Silence there is how the
 * artifact set grows a blind spot nobody can see: someone adds a new file shape under
 * a location that is already in scope, no rule claims it, and the gate reports a clean
 * pass over a file it never looked at.
 */
import { isDeclaredArtifact } from './patterns'

export type ArtifactKind =
  | 'catalog-skill'
  | 'catalog-meta'
  | 'catalog-reference'
  | 'installed-skill'
  | 'agent-pointer'
  | 'guidance'
  | 'speckit-template'
  | 'constitution'
  | 'unclassified'

/** Every kind that carries a metadata block rather than a markdown body. */
export const META_KINDS: readonly ArtifactKind[] = ['catalog-meta', 'agent-pointer']

/**
 * Every kind, for the rules that apply to all of them. Listed rather than derived, so
 * adding a kind is a change a reviewer sees in every place that has to care about it.
 */
export const ALL_KINDS: ArtifactKind[] = [
  'catalog-skill',
  'catalog-meta',
  'catalog-reference',
  'installed-skill',
  'agent-pointer',
  'guidance',
  'speckit-template',
  'constitution',
  'unclassified',
]

const CATALOG_ROOT = 'tooling/skills/catalog/'
const INSTALLED_ROOT = '.agents/skills/'
const POINTER_ROOT = '.claude/skills/'

interface KindPattern {
  kind: ArtifactKind
  test: (path: string) => boolean
}

const segments = (path: string): string[] => path.split('/')

const KIND_PATTERNS: readonly KindPattern[] = [
  {
    kind: 'catalog-meta',
    test: (path) => path.startsWith(CATALOG_ROOT) && path.endsWith('/skill.meta'),
  },
  {
    kind: 'catalog-skill',
    test: (path) =>
      path.startsWith(CATALOG_ROOT) && segments(path).length === 5 && path.endsWith('/SKILL.md'),
  },
  {
    kind: 'catalog-reference',
    test: (path) => path.startsWith(CATALOG_ROOT) && segments(path)[4] === 'references',
  },
  { kind: 'installed-skill', test: (path) => path.startsWith(INSTALLED_ROOT) },
  {
    kind: 'agent-pointer',
    test: (path) => path.startsWith(POINTER_ROOT) && path.endsWith('/SKILL.md'),
  },
  { kind: 'constitution', test: (path) => path === '.specify/memory/constitution.md' },
  { kind: 'speckit-template', test: (path) => path.startsWith('.specify/templates/') },
  {
    kind: 'guidance',
    test: (path) =>
      path === 'AGENTS.md' ||
      path === 'CLAUDE.md' ||
      path.startsWith('.claude/rules/') ||
      (path.startsWith('.agents/') && !path.startsWith(INSTALLED_ROOT)),
  },
]

/**
 * Classify a repo-relative path. Returns null when the path is not a declared
 * artifact at all — that is "out of scope", which is different from `unclassified`
 * and must not be conflated with it.
 */
export const classify = (path: string): ArtifactKind | null => {
  if (!isDeclaredArtifact(path)) return null
  return KIND_PATTERNS.find((pattern) => pattern.test(path))?.kind ?? 'unclassified'
}

/**
 * The skill directory an artifact belongs to — the second of the three roots
 * `refs/dangling-path` resolves against (research R2). Null for anything that is not
 * part of a skill.
 */
export const skillRootOf = (path: string): string | null => {
  for (const root of [CATALOG_ROOT, INSTALLED_ROOT, POINTER_ROOT]) {
    if (!path.startsWith(root)) continue
    const name = path.slice(root.length).split('/')[0]
    if (name.length === 0) return null
    return `${root}${name}`
  }
  return null
}

/** The skill's name, for the cross-tree `install/*` rules that pair two trees by it. */
export const skillNameOf = (path: string): string | null =>
  skillRootOf(path)?.split('/').pop() ?? null
