import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  applyBaseline,
  baselinePathIn,
  DEFAULT_BASELINE_PATH,
  emptyBaseline,
  loadBaseline,
  parseBaseline,
  type Baseline,
  type BaselineEntry,
} from './baseline'
import type { Finding, RuleId, Severity } from './rules'

/** A registered, non-bookkeeping rule — the only kind an entry may name. */
const RULE: RuleId = 'refs/dangling-path'
/** A registered bookkeeping rule, which reports on the run and cannot be baselined. */
const BOOKKEEPING_RULE: RuleId = 'artifact/unreadable'

const PATH = 'tooling/skills/catalog/example/SKILL.md'

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  rule: RULE,
  severity: 'error',
  path: PATH,
  line: 12,
  related: [],
  message: 'References `x/y.md`, which does not exist.',
  remediation: 'Correct the path, or create the file.',
  ...overrides,
})

const entry = (overrides: Partial<BaselineEntry> = {}): BaselineEntry => ({
  rule: RULE,
  path: PATH,
  reason: 'Predates the rule; scheduled for the next skills pass.',
  ...overrides,
})

const baseline = (...entries: BaselineEntry[]): Baseline => ({
  path: 'tooling/prompt-lint/baseline.json',
  entries,
})

/** A throwaway file, for the cases that are about reading one rather than parsing one. */
const writeBaselineFile = (content: string): string => {
  const path = baselinePathIn(mkdtempSync(join(tmpdir(), 'prompt-lint-baseline-')))
  writeFileSync(path, content)
  return path
}

describe('loadBaseline', () => {
  it('reads this package’s own baseline.json from the default path', () => {
    // The default is resolved from this module, not from the repository under evaluation:
    // the gate’s suite runs against temporary repos, and a root-derived path would make
    // those runs read a baseline that is not there. Loading it here is what proves the
    // resolution works under vitest as well as under node.
    const result = loadBaseline()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.path).toBe(DEFAULT_BASELINE_PATH)
    // T039 shipped it empty and T058 populated it from a measured run. Asserting a count
    // here would make this test a change-detector for the adoption state, which drains by
    // design — so it asserts the shape every entry must hold instead. A malformed entry is
    // caught at load, and this is the one place the *real* file goes through that load.
    for (const entry of result.value.entries) {
      expect(entry.rule, JSON.stringify(entry)).toMatch(/^[^/]+\/[^/]+$/)
      expect(entry.path.length, entry.rule).toBeGreaterThan(0)
      expect(entry.reason.trim().length, `${entry.rule} ${entry.path}`).toBeGreaterThan(0)
    }
  })

  it('reads an explicitly named file, so the location is never inferred', () => {
    const path = writeBaselineFile(
      `{"entries":[{"rule":"${RULE}","path":"${PATH}","reason":"measured at adoption"}]}`,
    )
    const result = loadBaseline(path)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.entries).toEqual([
      { rule: RULE, path: PATH, reason: 'measured at adoption' },
    ])
  })

  it('treats a missing file as an empty baseline rather than a failure', () => {
    // A repository with nothing to baseline is the state this file is working towards,
    // so its absence is legitimate and must not be reported as a broken tool.
    const result = loadBaseline(baselinePathIn(mkdtempSync(join(tmpdir(), 'prompt-lint-none-'))))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.entries).toEqual([])
  })

  it('reports a file it cannot read as a failure, not as an empty baseline', () => {
    // A directory where a file should be: something is wrong with the checkout, and
    // downgrading nothing while claiming to have read the baseline is the failure mode
    // this whole module is shaped to avoid.
    const result = loadBaseline(mkdtempSync(join(tmpdir(), 'prompt-lint-dir-')))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('unreadable')
  })
})

describe('parseBaseline', () => {
  const parse = (source: string): ReturnType<typeof parseBaseline> =>
    parseBaseline('baseline.json', source)

  it('accepts the empty documented shape', () => {
    expect(parse('{"entries":[]}')).toEqual({
      ok: true,
      value: { path: 'baseline.json', entries: [] },
    })
  })

  it('ignores the header comment key, which is how the file documents itself', () => {
    // JSON has no comments, so the header lives in a `$comment` string. A parser that
    // rejected unknown keys would make the file impossible to explain.
    const result = parse(
      `{"$comment":["this file must drain"],"entries":[{"rule":"${RULE}","path":"${PATH}","reason":"why"}]}`,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.entries).toHaveLength(1)
  })

  it('reports invalid JSON as a typed failure', () => {
    // Never an empty entry list: a baseline that silently fails to load downgrades
    // nothing, and a run that downgrades nothing looks exactly like a clean pass.
    const result = parse('{"entries": [},')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('malformed-json')
    expect(result.failure.path).toBe('baseline.json')
    expect(result.failure.message).toContain('baseline.json')
  })

  it('reports a document that is not an object, or has no entries array', () => {
    for (const source of ['[]', '"nothing"', '{}', '{"entries":{}}']) {
      const result = parse(source)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.failure.kind).toBe('invalid-shape')
    }
  })

  it('reports an entry missing any required field, naming its position', () => {
    const cases: Record<string, string> = {
      rule: `{"entries":[{"path":"${PATH}","reason":"why"}]}`,
      path: `{"entries":[{"rule":"${RULE}","reason":"why"}]}`,
      reason: `{"entries":[{"rule":"${RULE}","path":"${PATH}"}]}`,
    }
    for (const [field, source] of Object.entries(cases)) {
      const result = parse(source)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.failure.kind).toBe('invalid-shape')
      expect(result.failure.message).toContain(field)
      expect(result.failure.message).toContain('entries[0]')
    }
  })

  it('reports a blank reason, which is an exemption nobody had to justify', () => {
    const result = parse(`{"entries":[{"rule":"${RULE}","path":"${PATH}","reason":"   "}]}`)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.message).toContain('reason')
  })

  it('reports an entry that is not an object at all', () => {
    const result = parse('{"entries":["refs/dangling-path"]}')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.message).toContain('not an object')
  })
})

describe('applyBaseline', () => {
  it('downgrades a matched finding to note and marks it baselined', () => {
    const { findings, applied, stale } = applyBaseline([finding()], baseline(entry()))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ severity: 'note', baselined: true })
    expect(applied).toBe(1)
    expect(stale).toEqual([])
  })

  it('keeps the finding rather than removing it, so the report can still name it', () => {
    // The baseline is a severity change, not a filter: a `note` still appears in the
    // output, which is what lets a reader see how much the file is still holding back.
    const [downgraded] = applyBaseline([finding()], baseline(entry())).findings
    expect(downgraded).toMatchObject({ rule: RULE, path: PATH, line: 12 })
  })

  it('downgrades every occurrence in the file, and the entry is not stale', () => {
    // Keying on `rule` + `path` means an entry covers the file, not one line. That is the
    // trade for a file that does not churn on every unrelated edit above the defect.
    const result = applyBaseline([finding({ line: 4 }), finding({ line: 40 })], baseline(entry()))
    expect(result.applied).toBe(2)
    expect(result.stale).toEqual([])
  })

  it('leaves an unmatched finding untouched', () => {
    const result = applyBaseline([finding()], baseline())
    expect(result.findings).toEqual([finding()])
    expect(result.applied).toBe(0)
  })

  it('does not match the same rule in a different path', () => {
    const result = applyBaseline([finding()], baseline(entry({ path: 'other/SKILL.md' })))
    expect(result.findings[0].severity).toBe('error')
    expect(result.applied).toBe(0)
    expect(result.stale).toHaveLength(1)
  })

  it('does not match a different rule in the same path', () => {
    const result = applyBaseline([finding()], baseline(entry({ rule: 'skill/section-missing' })))
    expect(result.findings[0].severity).toBe('error')
    expect(result.applied).toBe(0)
    expect(result.stale).toHaveLength(1)
  })

  describe('stale entries (FR-010)', () => {
    it('reports an entry that matched nothing, at warn, naming the rule and the path', () => {
      // This is the mechanism that makes the file drain: fix the defect, and the entry
      // that recorded it starts asking to be deleted.
      const { stale } = applyBaseline([], baseline(entry()))
      expect(stale).toHaveLength(1)
      expect(stale[0]).toMatchObject({
        rule: 'suppression/stale',
        severity: 'warn' satisfies Severity,
        path: PATH,
        line: 0,
      })
      expect(stale[0].message).toContain(RULE)
      expect(stale[0].message).toContain(PATH)
      expect(stale[0].remediation).toContain('Delete the entry')
    })

    it('reports an entry naming a rule that is not registered, and says so', () => {
      // The same distinction suppressions draw: "the defect is fixed" and "this id names
      // nothing" are different mistakes, and each needs its own remediation. Rule ids are
      // permanent, so this is also what catches a rename.
      const { stale } = applyBaseline([], baseline(entry({ rule: 'refs/dangling-paths' })))
      expect(stale).toHaveLength(1)
      expect(stale[0].message).toContain('not a registered rule')
      expect(stale[0].remediation).toContain('Rule ids are permanent')
    })

    it('does not report a stale entry when the finding is still there', () => {
      expect(applyBaseline([finding()], baseline(entry())).stale).toEqual([])
    })

    it('reports each stale entry once, and only the stale ones', () => {
      const result = applyBaseline(
        [finding()],
        baseline(entry(), entry({ path: 'gone/SKILL.md' }), entry({ rule: 'nope/nope' })),
      )
      expect(result.applied).toBe(1)
      // Two stale entries — the one whose file has no such finding and the one whose id
      // names nothing — and none for the entry that did its job. The gate orders findings
      // afterwards, so only the set matters here.
      expect(result.stale).toHaveLength(2)
      expect(result.stale.map((item) => item.message)).toEqual([
        expect.stringContaining('nope/nope'),
        expect.stringContaining('gone/SKILL.md'),
      ])
    })
  })

  describe('bookkeeping rules cannot be baselined', () => {
    const bookkeepingFindingFixture = finding({
      rule: BOOKKEEPING_RULE,
      message: 'Could not be read as an artifact: unreadable.',
      remediation: 'Make the file readable UTF-8 text that is not a symlink.',
    })

    it('leaves a bookkeeping finding at its own severity', () => {
      // A report that cannot say "I could not read this file" is worse than a red one, so
      // no entry may turn one of these down.
      const result = applyBaseline(
        [bookkeepingFindingFixture],
        baseline(entry({ rule: BOOKKEEPING_RULE })),
      )
      expect(result.findings[0]).toMatchObject({ severity: 'error' })
      expect(result.findings[0].baselined).toBeUndefined()
      expect(result.applied).toBe(0)
    })

    it('reports the entry as stale rather than failing the load', () => {
      // Stale, not a load error: the entry exempts nothing, which is exactly the stale
      // condition, and it reaches the reader in the same report as everything else.
      // Refusing the load would be exit 3 with no artifact evaluated — a report that says
      // nothing about the prompts, over an entry that was already inert.
      const { stale } = applyBaseline([], baseline(entry({ rule: BOOKKEEPING_RULE })))
      expect(stale).toHaveLength(1)
      expect(stale[0].message).toContain('cannot be baselined')
    })
  })

  it('changes nothing for an empty baseline, which is what --no-baseline runs on', () => {
    const findings = [finding(), finding({ path: 'other/SKILL.md' })]
    expect(applyBaseline(findings, emptyBaseline())).toEqual({ findings, applied: 0, stale: [] })
  })

  it('does not mutate the entries it was given, so a second run answers the same', () => {
    const shared = baseline(entry())
    const first = applyBaseline([finding()], shared)
    const second = applyBaseline([finding()], shared)
    expect(second).toEqual(first)
  })
})
