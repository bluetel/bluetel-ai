/**
 * The only code in the tree that reads the filesystem for artifact content. Every
 * rule downstream of it is a pure function over what this produced, which is what
 * makes the rule suites fixture-driven and FR-029's determinism structural rather
 * than a matter of discipline.
 *
 * A file that could not be read keeps its place in the model with a `readError` set.
 * It is never dropped: the rules that needed its content have to be recorded as **not
 * evaluated** rather than as passing, and a dropped artifact is indistinguishable from
 * a clean one.
 */
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ArtifactKind } from '../scope'

import { parseFrontmatter } from './frontmatter'
import { parseMarkdown, type MarkdownView } from './markdown'
import { parseSkillMeta, type MetaBlock } from './meta'
import { parseSuppressions, type Suppression } from './suppress'

export type ReadError = 'not-utf8' | 'symlink' | 'empty' | 'unreadable'

export interface Artifact {
  /** Repo-relative, POSIX separators, stable across machines (FR-039). */
  path: string
  kind: ArtifactKind
  /** Raw content, or null when unreadable — see `readError`. */
  content: string | null
  readError: ReadError | null
  /** Line-indexed view; null when content is null or the artifact has no markdown body. */
  view: MarkdownView | null
  /** Parsed metadata for the kinds that have it; null otherwise or on parse failure. */
  meta: MetaBlock | null
  /** Token count from the analyser's breakdown. Null until the delegated pass runs. */
  tokens: number | null
  /** The skill directory this artifact belongs to, for R2's three-root resolution. */
  skillRoot: string | null
  suppressions: Suppression[]
}

/** Kinds whose body is not markdown, so no `MarkdownView` is built for them. */
const NON_MARKDOWN_KINDS: readonly ArtifactKind[] = ['catalog-meta']

/**
 * Is this buffer valid UTF-8? Node's decoder substitutes U+FFFD for invalid bytes
 * rather than throwing, so the only exact test is a round-trip comparison — a real
 * U+FFFD in the source survives it, an invalid byte sequence does not.
 */
const isValidUtf8 = (buffer: Buffer): boolean =>
  Buffer.compare(Buffer.from(buffer.toString('utf8'), 'utf8'), buffer) === 0

interface ReadResult {
  content: string | null
  readError: ReadError | null
}

const readContent = (absolute: string): ReadResult => {
  let stats
  try {
    stats = lstatSync(absolute)
  } catch {
    return { content: null, readError: 'unreadable' }
  }

  // A symlink is refused rather than followed: what the gate reports must be a
  // property of a file in this repository, not of wherever a link happens to point.
  if (stats.isSymbolicLink()) return { content: null, readError: 'symlink' }
  if (!stats.isFile()) return { content: null, readError: 'unreadable' }

  let buffer: Buffer
  try {
    buffer = readFileSync(absolute)
  } catch {
    return { content: null, readError: 'unreadable' }
  }

  if (!isValidUtf8(buffer)) return { content: null, readError: 'not-utf8' }

  const content = buffer.toString('utf8')
  // An empty artifact is a defect, not an absence: a `SKILL.md` with no body installs
  // and runs, and does nothing.
  if (content.trim().length === 0) return { content: null, readError: 'empty' }

  return { content, readError: null }
}

/** Parse the metadata block a kind carries, if it carries one. */
const parseMeta = (kind: ArtifactKind, content: string): MetaBlock | null => {
  if (kind === 'catalog-meta') return parseSkillMeta(content)
  if (kind === 'agent-pointer') return parseFrontmatter(content).meta
  return null
}

/** Read and parse one artifact. `path` is repo-relative; `repoRoot` is absolute. */
export const loadArtifact = (
  repoRoot: string,
  path: string,
  kind: ArtifactKind,
  skillRoot: string | null,
): Artifact => {
  const { content, readError } = readContent(join(repoRoot, path))

  if (content === null) {
    return {
      path,
      kind,
      content: null,
      readError,
      view: null,
      meta: null,
      tokens: null,
      skillRoot,
      suppressions: [],
    }
  }

  return {
    path,
    kind,
    content,
    readError: null,
    view: NON_MARKDOWN_KINDS.includes(kind) ? null : parseMarkdown(content),
    meta: parseMeta(kind, content),
    tokens: null,
    skillRoot,
    suppressions: parseSuppressions(content, kind === 'catalog-meta' ? 'skill-meta' : 'markdown'),
  }
}
