import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { ALL_KINDS } from '../scope'

import {
  BOOKKEEPING_RULES,
  configurableRules,
  localRules,
  RULE_IDS,
  ruleById,
  RULES,
} from './registry'

describe('the registry', () => {
  it('registers every rule exactly once', () => {
    expect(new Set(RULE_IDS).size).toBe(RULES.length)
  })

  it('gives every rule a `family/name` id', () => {
    for (const rule of RULES) {
      expect(rule.id, rule.id).toMatch(/^[a-z]+\/[a-z][a-z-]*[a-z]$/)
    }
  })

  it('gives every rule a non-empty statement and rationale', () => {
    // Surfaced by `--list-rules` and `--explain`. A rule that cannot say what it enforces
    // or why is a rule nobody can decide whether to promote.
    for (const rule of RULES) {
      expect(rule.statement.trim().length, rule.id).toBeGreaterThan(0)
      expect(rule.rationale.trim().length, rule.id).toBeGreaterThan(0)
    }
  })

  it('gives every artifact-scoped rule a non-empty appliesTo', () => {
    for (const rule of RULES) {
      if (rule.scope !== 'artifact') continue
      expect(rule.appliesTo.length, rule.id).toBeGreaterThan(0)
    }
  })

  it('names only real kinds in appliesTo', () => {
    for (const rule of RULES) {
      for (const kind of rule.appliesTo) expect(ALL_KINDS, rule.id).toContain(kind)
    }
  })

  it('gives every rule a severity the gate understands', () => {
    for (const rule of RULES) {
      expect(['error', 'warn', 'note'], rule.id).toContain(rule.defaultSeverity)
    }
  })

  it('marks a correctness rule as correctness and a delegated one as its own dimension', () => {
    for (const rule of RULES) {
      if (rule.source === 'prompt-lint') expect(rule.dimension, rule.id).toBe('correctness')
    }
  })

  it('finds a rule by id, and nothing by an unknown one', () => {
    expect(ruleById('refs/dangling-path')?.id).toBe('refs/dangling-path')
    expect(ruleById('refs/renamed-away')).toBeUndefined()
  })

  it('separates the four bookkeeping rules from the configurable ones', () => {
    // They describe the run rather than an artifact's content, so there is nothing to
    // promote, demote or baseline: a report that cannot say "I could not read this file"
    // is worse than a red one.
    const bookkeeping = Object.values(BOOKKEEPING_RULES)
    expect(bookkeeping).toHaveLength(4)
    for (const rule of bookkeeping) expect(rule.bookkeeping, rule.id).toBe(true)
    expect(configurableRules()).toHaveLength(RULES.length - 4)
    for (const rule of configurableRules()) expect(rule.bookkeeping, rule.id).toBeUndefined()
  })

  it('lists the bookkeeping rules the contract names', () => {
    expect(
      Object.values(BOOKKEEPING_RULES)
        .map((rule) => rule.id)
        .sort(),
    ).toEqual([
      'artifact/unclassified',
      'artifact/unreadable',
      'suppression/stale',
      'suppression/unreasoned',
    ])
  })

  it('lets every rule that evaluates something produce a non-empty remediation (SC-006)', () => {
    // Enforced by a test rather than by review: `defineRule` throws on an empty
    // remediation, so a rule that cannot say how to fix its finding cannot ship.
    for (const rule of localRules()) {
      expect(typeof rule.check, rule.id).toBe('function')
    }
  })

  it('declares no rule the config could name but the registry could not resolve', () => {
    // This is the invariant `validateConfig` relies on to catch a rename.
    for (const id of RULE_IDS) expect(ruleById(id), id).toBeDefined()
  })
})

/**
 * FR-047 / SC-010 — the shipped catalogue and the registry describe the same rule set.
 *
 * The file is read from disk rather than imported, because `docs/rules.md` is the artifact
 * under test: it is the copy a contributor is pointed at, so its being right is the whole
 * requirement. The path is resolved from this module's own location — the package is ESM, so
 * `__dirname` does not exist and `fileURLToPath(import.meta.url)` is what works under both
 * vitest and `tsc`.
 *
 * The parse is deliberately dumb, and `docs/rules.md` states the convention it relies on in a
 * comment at the top of the file: one level-3 heading per rule whose text is exactly the id in
 * backticks, and the shipped severity in the first `**Ships as**` line beneath it.
 */
const CATALOGUE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'rules.md')
const CATALOGUE = readFileSync(CATALOGUE_PATH, 'utf8')

const ENTRY_HEADING = /^### `([^`\n]+)`$/gm
const SHIPS_AS = /\*\*Ships as\*\* `(error|warn|note)`/

interface CatalogueEntry {
  id: string
  /** Null when the entry carries no `**Ships as**` line, which is itself a failure. */
  severity: string | null
}

/** Every entry in the catalogue, in file order, with the severity it claims to ship at. */
const parseCatalogue = (markdown: string): CatalogueEntry[] => {
  const headings = [...markdown.matchAll(ENTRY_HEADING)]

  return headings.map((heading, position) => {
    const start = heading.index + heading[0].length
    const end = headings[position + 1]?.index ?? markdown.length
    return { id: heading[1], severity: SHIPS_AS.exec(markdown.slice(start, end))?.[1] ?? null }
  })
}

const ENTRIES = parseCatalogue(CATALOGUE)

describe('the shipped rule catalogue (docs/rules.md)', () => {
  it('parses at all, so a failure below is a real disagreement and not a broken convention', () => {
    // Named separately because "0 entries" is the one failure the two assertions below would
    // report as "every rule is undocumented" — a true statement that sends the reader to the
    // wrong file.
    expect(ENTRIES.length).toBeGreaterThan(0)
  })

  it('documents every registered rule, and registers every documented rule', () => {
    const documented = new Set(ENTRIES.map((entry) => entry.id))
    const undocumented = RULE_IDS.filter((id) => !documented.has(id))
    const orphaned = [...documented].filter((id) => ruleById(id) === undefined)

    // Both directions in one assertion, so the diff names the ids either way: a rule added
    // without its entry, and an entry that outlived the rule it described.
    expect({ undocumented, orphaned }).toEqual({ undocumented: [], orphaned: [] })
  })

  it('gives each rule exactly one entry', () => {
    const seen = new Map<string, number>()
    for (const entry of ENTRIES) seen.set(entry.id, (seen.get(entry.id) ?? 0) + 1)
    const duplicated = [...seen.entries()]
      .filter(([, count]) => count > 1)
      .map(([id, count]) => `${id} (${String(count)} entries)`)

    // Two entries for one rule would satisfy both directions above while the catalogue says
    // two different things about the same rule.
    expect(duplicated).toEqual([])
  })

  it('states the severity each rule actually ships at', () => {
    const wrong = ENTRIES.filter((entry) => ruleById(entry.id) !== undefined)
      .filter((entry) => entry.severity !== ruleById(entry.id)?.defaultSeverity)
      .map(
        (entry) =>
          `${entry.id}: documented ${entry.severity ?? 'nothing'}, registered ${String(ruleById(entry.id)?.defaultSeverity)}`,
      )

    // A catalogue that lies about a severity is worse than one that is merely incomplete: it
    // is the number a reviewer decides whether to promote against.
    expect(wrong).toEqual([])
  })

  it('summarises itself in the counts the registry reports', () => {
    const stated =
      /\*\*Coverage\*\*: (\d+) rules · (\d+) families · (\d+) configurable · (\d+) bookkeeping/.exec(
        CATALOGUE,
      )
    expect(stated, 'docs/rules.md has no **Coverage** line').not.toBeNull()

    const families = new Set(RULES.map((rule) => rule.id.split('/')[0]))
    expect({
      rules: Number(stated?.[1]),
      families: Number(stated?.[2]),
      configurable: Number(stated?.[3]),
      bookkeeping: Number(stated?.[4]),
    }).toEqual({
      rules: RULES.length,
      families: families.size,
      configurable: configurableRules().length,
      bookkeeping: RULES.length - configurableRules().length,
    })
  })
})
