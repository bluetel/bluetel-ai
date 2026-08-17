/**
 * `skill.meta` is not YAML (research R4). It is `key=value`, one per line, with
 * **repeatable keys** (`next_step=` appears twice in `speckit-plan/skill.meta`) and
 * `|`-separated fields inside a value. The authority on the format is
 * `tooling/skills/lib/skills.sh`'s `meta_get`, which does line-oriented reads and
 * returns the *first* match — so a duplicated key means the value a reader sees and
 * the value the installer uses can differ. That is why duplicates are recorded here
 * rather than last-one-wins'd away, which is what a YAML parser would do.
 */

/** The metadata shape shared by `skill.meta` and `.claude/` frontmatter. */
export interface MetaBlock {
  format: 'skill-meta' | 'frontmatter'
  /** Every value of every key, in file order. Repeatable keys keep all of them. */
  entries: MetaEntry[]
  /** Keys seen more than once where the format does not permit repetition (FR-013). */
  duplicates: { key: string; lines: number[] }[]
  /** Lines inside the block that parsed as neither a comment nor a key/value pair (FR-013). */
  strayLines: number[]
}

export interface MetaEntry {
  key: string
  value: string
  /** 1-indexed, because every consumer of this is building a finding. */
  line: number
}

/** The only repeatable key in `skill.meta`. Everything else repeated is a duplicate. */
const REPEATABLE_KEYS = new Set(['next_step'])

const SKILL_META_PAIR = /^([A-Za-z0-9_-]+)=(.*)$/

/** First value for `key`, or undefined. Mirrors `meta_get`'s first-match semantics. */
export const metaGet = (meta: MetaBlock, key: string): string | undefined =>
  meta.entries.find((entry) => entry.key === key)?.value

/** Every value for `key`, in file order — the accessor `next_step=` needs. */
export const metaGetAll = (meta: MetaBlock, key: string): string[] =>
  meta.entries.filter((entry) => entry.key === key).map((entry) => entry.value)

/** Record the keys that repeated where the format forbids it. */
export const collectDuplicates = (entries: MetaEntry[]): { key: string; lines: number[] }[] => {
  const linesByKey = new Map<string, number[]>()
  for (const entry of entries) {
    const existing = linesByKey.get(entry.key)
    if (existing) existing.push(entry.line)
    else linesByKey.set(entry.key, [entry.line])
  }
  return [...linesByKey.entries()]
    .filter(([key, lines]) => lines.length > 1 && !REPEATABLE_KEYS.has(key))
    .map(([key, lines]) => ({ key, lines }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

/** Parse a `skill.meta` file's `key=value` lines. */
export const parseSkillMeta = (content: string): MetaBlock => {
  const entries: MetaEntry[] = []
  const strayLines: number[] = []

  content.split('\n').forEach((raw, index) => {
    const line = index + 1
    const trimmed = raw.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) return

    const pair = SKILL_META_PAIR.exec(raw)
    if (!pair) {
      // A wrapped long `description`, or a missing `=`. Either way the field looks
      // set and is not: a line-oriented reader skips it silently.
      strayLines.push(line)
      return
    }
    entries.push({ key: pair[1], value: pair[2].trim(), line })
  })

  return { format: 'skill-meta', entries, duplicates: collectDuplicates(entries), strayLines }
}
