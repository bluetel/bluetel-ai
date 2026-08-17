/**
 * The `---`-delimited frontmatter of a `.claude` skill pointer's `SKILL.md`, into the
 * same `MetaBlock` shape `skill.meta` produces.
 *
 * No YAML dependency, and the boundary is deliberate (research R4): every one of the
 * 17 pointers in this repository is a flat, single-line `key: value` block —
 * `name`, `description`, optionally `argument-hint` — with values sometimes
 * single-quoted. A parser that could express more would also silently last-one-wins
 * the duplicate keys `meta/duplicate-key` exists to find.
 *
 * A value this reader cannot represent (a block scalar, a nested map, a list) is a
 * stray line rather than a guess, so the finding says the block is malformed instead
 * of reporting a field that is not what it appears to be.
 */
import { collectDuplicates, type MetaBlock, type MetaEntry } from './meta'

const DELIMITER = /^---\s*$/
const FRONTMATTER_PAIR = /^([A-Za-z0-9_-]+):\s*(.*)$/

/** Strip one layer of matching quotes from a scalar value. */
const unquote = (value: string): string => {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if ((first === "'" || first === '"') && first === last) return value.slice(1, -1)
  return value
}

export interface FrontmatterResult {
  /** Null when the file has no frontmatter block at all — not every markdown file does. */
  meta: MetaBlock | null
  /** 0-indexed line after the closing delimiter — where the body starts. */
  bodyStartLine: number
}

/** Read the leading frontmatter block, if there is one, plus where the body begins. */
export const parseFrontmatter = (content: string): FrontmatterResult => {
  const lines = content.split('\n')
  if (lines.length === 0 || !DELIMITER.test(lines[0])) return { meta: null, bodyStartLine: 0 }

  const closing = lines.findIndex((line, index) => index > 0 && DELIMITER.test(line))
  // An unterminated block is not frontmatter; treating the rest of the file as
  // metadata would turn one missing `---` into a report about every prose line.
  if (closing === -1) return { meta: null, bodyStartLine: 0 }

  const entries: MetaEntry[] = []
  const strayLines: number[] = []

  for (let index = 1; index < closing; index += 1) {
    const raw = lines[index]
    const line = index + 1
    const trimmed = raw.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue

    const pair = FRONTMATTER_PAIR.exec(raw)
    if (!pair || pair[2].trim().length === 0) {
      strayLines.push(line)
      continue
    }
    entries.push({ key: pair[1], value: unquote(pair[2].trim()), line })
  }

  return {
    meta: { format: 'frontmatter', entries, duplicates: collectDuplicates(entries), strayLines },
    bodyStartLine: closing + 1,
  }
}
