import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EXIT, runPromptLintGate, type GateOptions } from './gate'

/** See `scope/git.test.ts` — inheriting `GIT_*` from a hook breaks every fixture repo. */
const GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
)

const git = (cwd: string, args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: GIT_ENV })
}

const write = (root: string, path: string, content: string): void => {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

const CLEAN_SKILL = '# Alpha\n\nDo the thing.\n\n## Done When\n\n- [ ] the thing is done\n'
const CLEAN_META = 'name=alpha\nversion=1.0.0\ndescription=Does a thing. Use when: needed.\n'

/** A repo whose artifact surface starts clean, so a finding is always something we added. */
const makeRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'prompt-lint-gate-'))
  git(root, ['init', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])

  write(root, 'AGENTS.md', '# Agents\n\nBe careful.\n')
  write(
    root,
    '.agents/skills.config',
    'repo_owner=bluetel\nrepo_name=bluetel-ai\nbase_branch=main\n',
  )
  write(root, 'tooling/skills/catalog/alpha/SKILL.md', CLEAN_SKILL)
  write(root, 'tooling/skills/catalog/alpha/skill.meta', CLEAN_META)
  write(root, 'tooling/skills/catalog/alpha/references/notes.md', '# Notes\n\nSee `../SKILL.md`.\n')
  write(root, 'tooling/skills/catalog/alpha/references/other.md', '# Other\n\nMore prose.\n')

  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'base'])
  return root
}

const options = (repoRoot: string, overrides: Partial<GateOptions> = {}): GateOptions => ({
  repoRoot,
  mode: 'all',
  applyBaseline: true,
  rulesOnly: true,
  ...overrides,
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('runPromptLintGate', () => {
  it('passes over a clean surface and reports what it looked at', () => {
    const outcome = runPromptLintGate(options(makeRepo()))
    expect(outcome.exitCode).toBe(EXIT.ok)
    expect(outcome.report?.verdict).toBe('pass')
    expect(outcome.report?.findings).toEqual([])
    expect(outcome.report?.scope.artifactCount).toBe(5)
    expect(outcome.report?.scope.universeCount).toBe(5)
  })

  it('fails with exit 1 when an error-severity finding exists', () => {
    const root = makeRepo()
    write(
      root,
      'tooling/skills/catalog/alpha/skill.meta',
      'name=alpha\nversion=nope\ndescription=d. Use when: x.\n',
    )

    const outcome = runPromptLintGate(options(root))
    expect(outcome.exitCode).toBe(EXIT.thresholds)
    expect(outcome.report?.verdict).toBe('fail')
    expect(outcome.report?.findings.map((f) => f.rule)).toContain('meta/version-semver')
  })

  it('reports zero artifacts and exits 0 when the diff touched no artifact (FR-040)', () => {
    const root = makeRepo()
    git(root, ['checkout', '-b', 'feature'])
    write(root, 'src/code.ts', 'export const x = 1\n')

    const outcome = runPromptLintGate(options(root, { mode: 'diff', baseRef: 'main' }))
    expect(outcome.exitCode).toBe(EXIT.ok)
    expect(outcome.report?.scope.artifactCount).toBe(0)
    // A consumer can tell "nothing to check" from "everything passed".
    expect(outcome.report?.scope.universeCount).toBe(5)
  })

  it('runs per-artifact rules over targets only', () => {
    const root = makeRepo()
    git(root, ['checkout', '-b', 'feature'])
    // Two defects; only one is in the diff.
    write(root, 'AGENTS.md', '# Agents\n\nTODO: decide.\n')

    const outcome = runPromptLintGate(options(root, { mode: 'diff', baseRef: 'main' }))
    expect(outcome.report?.scope.artifactCount).toBe(1)
    expect(outcome.report?.findings.every((f) => f.path === 'AGENTS.md')).toBe(true)
  })

  it('widens refs/dangling-path to universe when the diff deletes an artifact (US1 §4)', () => {
    // The referring artifact is in `universe` and not in `targets`. Getting this wrong
    // makes a deleted-reference defect silently pass, which is the whole reason the
    // targets/universe distinction exists.
    //
    // `references/` keeps a second file on purpose. Deleting the *only* file in a
    // directory removes the directory from the index too, and R2's rule 3 then stops
    // claiming the reference at all — correct by the algorithm, but a different case from
    // the one this test is about.
    const root = makeRepo()
    git(root, ['checkout', '-b', 'feature'])
    write(
      root,
      'tooling/skills/catalog/alpha/SKILL.md',
      `${CLEAN_SKILL}\nSee \`references/notes.md\`.\n`,
    )
    git(root, ['add', '-A'])
    git(root, ['commit', '-m', 'reference the notes'])
    git(root, ['rm', '--quiet', 'tooling/skills/catalog/alpha/references/notes.md'])
    git(root, ['commit', '-m', 'delete the notes'])

    const outcome = runPromptLintGate(options(root, { mode: 'diff', baseRef: 'main' }))
    const dangling = outcome.report?.findings.filter((f) => f.rule === 'refs/dangling-path') ?? []
    expect(dangling).toHaveLength(1)
    expect(dangling[0].path).toBe('tooling/skills/catalog/alpha/SKILL.md')
  })

  it('exits 4 with the ref named when the scope cannot be established (FR-032)', () => {
    const outcome = runPromptLintGate(options(makeRepo(), { mode: 'diff', baseRef: 'origin/nope' }))
    expect(outcome.exitCode).toBe(EXIT.scope)
    expect(outcome.report).toBeNull()
    expect(outcome.failures[0]).toContain('origin/nope')
  })

  it('exits 4 outside a git repository rather than evaluating nothing and passing', () => {
    const bare = mkdtempSync(join(tmpdir(), 'prompt-lint-bare-'))
    const outcome = runPromptLintGate(options(bare))
    expect(outcome.exitCode).toBe(EXIT.scope)
    rmSync(bare, { recursive: true, force: true })
  })

  it('exits 3 with no artifact evaluated when the config is invalid (FR-036)', () => {
    vi.stubEnv('PROMPT_LINT_MIN_SCORE', '500')
    const outcome = runPromptLintGate(options(makeRepo()))
    expect(outcome.exitCode).toBe(EXIT.config)
    expect(outcome.report).toBeNull()
    expect(outcome.failures[0]).toContain('minScore')
  })

  it('records an override in the report so a passing log cannot conceal it (FR-034)', () => {
    vi.stubEnv('PROMPT_LINT_MAX_ERRORS', '99')
    const root = makeRepo()
    write(root, 'AGENTS.md', '# Agents\n\nTODO: decide.\n')

    const outcome = runPromptLintGate(options(root))
    expect(outcome.exitCode).toBe(EXIT.ok)
    expect(outcome.report?.overrides).toEqual([{ name: 'PROMPT_LINT_MAX_ERRORS', value: '99' }])
  })

  describe('bookkeeping', () => {
    it('reports an unreadable artifact and marks the rules that needed it not-evaluated', () => {
      const root = makeRepo()
      write(root, 'tooling/skills/catalog/alpha/skill.meta', '   \n')

      const outcome = runPromptLintGate(options(root))
      expect(outcome.report?.findings.map((f) => f.rule)).toContain('artifact/unreadable')
      // Never silence: the metadata rules did not pass, they did not run.
      expect(outcome.report?.notEvaluated.map((entry) => entry.rule)).toContain(
        'meta/required-field',
      )
    })

    it('reports an unreasoned suppression, which exempts nothing', () => {
      const root = makeRepo()
      write(
        root,
        'AGENTS.md',
        '# Agents\n<!-- prompt-lint-disable-next-line template/placeholder-residue -->\nTODO: decide.\n',
      )

      const outcome = runPromptLintGate(options(root))
      const rules = outcome.report?.findings.map((f) => f.rule) ?? []
      expect(rules).toContain('suppression/unreasoned')
      // The defect is still reported: an unreasoned suppression must not be more powerful
      // than the documented form.
      expect(rules).toContain('template/placeholder-residue')
    })

    it('honours a reasoned suppression and counts it as used', () => {
      const root = makeRepo()
      write(
        root,
        'AGENTS.md',
        '# Agents\n<!-- prompt-lint-disable-next-line template/placeholder-residue — tracked in BTAI-1 -->\nTODO: decide.\n',
      )

      const outcome = runPromptLintGate(options(root))
      expect(outcome.report?.findings.map((f) => f.rule)).not.toContain(
        'template/placeholder-residue',
      )
      expect(outcome.report?.suppressions.used).toBe(1)
      expect(outcome.exitCode).toBe(EXIT.ok)
    })

    it('reports a suppression that no longer matches as stale (FR-010)', () => {
      const root = makeRepo()
      write(
        root,
        'AGENTS.md',
        '# Agents\n<!-- prompt-lint-disable-next-line template/placeholder-residue — fixed already -->\nAll clean now.\n',
      )

      const outcome = runPromptLintGate(options(root))
      const stale = outcome.report?.findings.filter((f) => f.rule === 'suppression/stale') ?? []
      expect(stale).toHaveLength(1)
      expect(stale[0].remediation).toContain('Delete the suppression')
    })

    it('reports a suppression naming an unregistered rule', () => {
      const root = makeRepo()
      write(
        root,
        'AGENTS.md',
        '# Agents\n<!-- prompt-lint-disable-next-line refs/renamed-away — stale id -->\nText.\n',
      )

      const outcome = runPromptLintGate(options(root))
      const stale = outcome.report?.findings.find((f) => f.rule === 'suppression/stale')
      expect(stale?.message).toContain('not a registered rule')
    })
  })

  it('orders findings canonically and counts every severity', () => {
    const root = makeRepo()
    write(root, 'AGENTS.md', '# Agents\n\nTODO: a.\nTODO: b.\n')

    const outcome = runPromptLintGate(options(root))
    const lines = outcome.report?.findings.map((f) => f.line) ?? []
    expect(lines).toEqual([...lines].sort((a, b) => a - b))
    expect(outcome.report?.counts).toMatchObject({ note: 0 })
  })

  it('serialises the thresholds the verdict was actually computed against', () => {
    const outcome = runPromptLintGate(options(makeRepo()))
    expect(outcome.report?.thresholds).toMatchObject({ maxErrors: 0, maxWarnings: 50 })
  })

  it('produces byte-identical reports over an unchanged tree (SC-005)', () => {
    const root = makeRepo()
    write(root, 'AGENTS.md', '# Agents\n\nTODO: decide.\n')
    const first = JSON.stringify(runPromptLintGate(options(root)).report)
    const second = JSON.stringify(runPromptLintGate(options(root)).report)
    expect(first).toBe(second)
  })

  it('narrows to a named subset', () => {
    const outcome = runPromptLintGate(options(makeRepo(), { subset: 'guidance' }))
    expect(outcome.report?.scope.artifactCount).toBe(1)
  })
})
