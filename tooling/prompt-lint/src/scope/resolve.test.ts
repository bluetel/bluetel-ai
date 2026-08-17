import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

import { describe, expect, it } from 'vitest'

import { buildPathIndex, resolveScope } from './resolve'

/** See `scope/git.test.ts` — inheriting `GIT_*` from a hook breaks every fixture repo. */
const GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
)

const run = (cwd: string, args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: GIT_ENV })
}

const write = (root: string, path: string, content: string): void => {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

/** A repo carrying a small but real version of this repository's artifact surface. */
const makeRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'prompt-lint-resolve-'))
  run(root, ['init', '--initial-branch=main'])
  run(root, ['config', 'user.email', 'test@example.com'])
  run(root, ['config', 'user.name', 'Test'])

  write(root, 'AGENTS.md', '# agents\n')
  write(root, 'CLAUDE.md', '# claude\n')
  write(root, 'tooling/skills/catalog/alpha/SKILL.md', '# alpha\n\n## Done When\n\n- [ ] x\n')
  write(
    root,
    'tooling/skills/catalog/alpha/skill.meta',
    'name=alpha\nversion=1.0.0\ndescription=d\n',
  )
  write(root, 'tooling/skills/catalog/alpha/references/notes.md', '# notes\n')
  write(root, 'src/not-an-artifact.ts', 'export const x = 1\n')
  write(root, 'specs/001-x/spec.md', '# spec\n')

  run(root, ['add', '.'])
  run(root, ['commit', '-m', 'base'])
  return root
}

describe('buildPathIndex', () => {
  it('knows files, and the directories they imply', () => {
    const index = buildPathIndex(['a/b/c.md', 'a/d.md'])
    expect(index.has('a/b/c.md')).toBe(true)
    expect(index.has('a/b')).toBe(true)
    expect(index.isDirectory('a')).toBe(true)
    expect(index.isDirectory('a/b/c.md')).toBe(false)
    expect(index.has('a/nope.md')).toBe(false)
  })

  it('lists paths under a prefix, sorted, for the cross-tree rules', () => {
    const index = buildPathIndex(['x/b.md', 'x/a.md', 'y/c.md'])
    expect(index.under('x')).toEqual(['x/a.md', 'x/b.md'])
    expect(index.under('x/')).toEqual(['x/a.md', 'x/b.md'])
    expect(index.under('z')).toEqual([])
  })
})

describe('resolveScope', () => {
  it('builds the universe from the declared set only', () => {
    const result = resolveScope({ repoRoot: makeRepo(), mode: 'all', exclude: [] })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.universe.map((a) => a.path).sort()).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      'tooling/skills/catalog/alpha/SKILL.md',
      'tooling/skills/catalog/alpha/references/notes.md',
      'tooling/skills/catalog/alpha/skill.meta',
    ])
  })

  it('makes targets equal universe under --all', () => {
    const result = resolveScope({ repoRoot: makeRepo(), mode: 'all', exclude: [] })
    if (!result.ok) throw new Error('expected a resolved scope')
    expect(result.value.targets).toHaveLength(result.value.universe.length)
    expect(result.value.deleted).toEqual([])
    expect(result.value.baseRef).toBeUndefined()
  })

  it('narrows targets to the changed artifacts while universe stays whole (the US1 §4 property)', () => {
    const root = makeRepo()
    run(root, ['checkout', '-b', 'feature'])
    write(root, 'AGENTS.md', '# agents, edited\n')

    const result = resolveScope({ repoRoot: root, mode: 'diff', baseRef: 'main', exclude: [] })
    if (!result.ok) throw new Error('expected a resolved scope')

    // Per-artifact rules run over `targets`; set-scoped rules run over `universe`.
    // Getting this backwards is what makes a deleted-reference finding silently vanish.
    expect(result.value.targets.map((a) => a.path)).toEqual(['AGENTS.md'])
    expect(result.value.universe).toHaveLength(5)
    expect(result.value.baseRef).toBe('main')
  })

  it('reports a deleted artifact in `deleted` without putting it in targets', () => {
    const root = makeRepo()
    run(root, ['checkout', '-b', 'feature'])
    run(root, ['rm', '--quiet', 'tooling/skills/catalog/alpha/references/notes.md'])
    run(root, ['commit', '-m', 'drop notes'])

    const result = resolveScope({ repoRoot: root, mode: 'diff', baseRef: 'main', exclude: [] })
    if (!result.ok) throw new Error('expected a resolved scope')

    expect(result.value.deleted).toEqual(['tooling/skills/catalog/alpha/references/notes.md'])
    expect(result.value.targets).toEqual([])
    expect(result.value.universe.map((a) => a.path)).not.toContain(
      'tooling/skills/catalog/alpha/references/notes.md',
    )
  })

  it('ignores source code and specs even when the diff touches them', () => {
    const root = makeRepo()
    run(root, ['checkout', '-b', 'feature'])
    write(root, 'src/not-an-artifact.ts', 'export const x = 2\n')
    write(root, 'specs/001-x/spec.md', '# spec, edited\n')

    const result = resolveScope({ repoRoot: root, mode: 'diff', baseRef: 'main', exclude: [] })
    if (!result.ok) throw new Error('expected a resolved scope')
    expect(result.value.targets).toEqual([])
  })

  it('records every exclusion with its reason (FR-005)', () => {
    const result = resolveScope({
      repoRoot: makeRepo(),
      mode: 'all',
      exclude: [{ glob: 'tooling/skills/catalog/*/references/**/*.md', reason: 'vendored' }],
    })
    if (!result.ok) throw new Error('expected a resolved scope')

    expect(result.value.exclusions).toEqual([
      { path: 'tooling/skills/catalog/alpha/references/notes.md', reason: 'vendored' },
    ])
    expect(result.value.universe.map((a) => a.path)).not.toContain(
      'tooling/skills/catalog/alpha/references/notes.md',
    )
  })

  it('narrows to a named subset', () => {
    const result = resolveScope({
      repoRoot: makeRepo(),
      mode: 'all',
      subset: 'guidance',
      exclude: [],
    })
    if (!result.ok) throw new Error('expected a resolved scope')
    expect(result.value.universe.map((a) => a.path).sort()).toEqual(['AGENTS.md', 'CLAUDE.md'])
  })

  it('classifies and loads each artifact, with its skill root', () => {
    const result = resolveScope({ repoRoot: makeRepo(), mode: 'all', exclude: [] })
    if (!result.ok) throw new Error('expected a resolved scope')

    const skill = result.value.universe.find((a) => a.path.endsWith('alpha/SKILL.md'))
    expect(skill).toMatchObject({
      kind: 'catalog-skill',
      skillRoot: 'tooling/skills/catalog/alpha',
      readError: null,
    })
    expect(skill?.view).not.toBeNull()
  })

  it('propagates a scope failure rather than resolving an empty scope', () => {
    const result = resolveScope({
      repoRoot: makeRepo(),
      mode: 'diff',
      baseRef: 'origin/nope',
      exclude: [],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.kind).toBe('unresolvable-ref')
  })

  it('fails outside a repository', () => {
    const bare = mkdtempSync(join(tmpdir(), 'prompt-lint-bare-'))
    const result = resolveScope({ repoRoot: bare, mode: 'all', exclude: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.kind).toBe('no-repo')
    rmSync(bare, { recursive: true, force: true })
  })
})
