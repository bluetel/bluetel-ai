import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  fileAtRef,
  isRepository,
  listAllFiles,
  listChangedFiles,
  listStagedFiles,
  parseNameStatus,
} from './git'

/**
 * `GIT_*` is stripped for the same reason `scope/git.ts` strips it: this suite runs from
 * `.husky/pre-commit`, where git has set `GIT_DIR` and `GIT_INDEX_FILE`, and inheriting
 * them makes every command below operate on the outer repository instead of the fixture.
 */
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

/** A repo with one commit on `main`, so a base ref exists to diff against. */
const makeRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'prompt-lint-git-'))
  run(root, ['init', '--initial-branch=main'])
  run(root, ['config', 'user.email', 'test@example.com'])
  run(root, ['config', 'user.name', 'Test'])
  write(root, 'AGENTS.md', '# base\n')
  write(root, 'keep.md', '# keep\n')
  run(root, ['add', '.'])
  run(root, ['commit', '-m', 'base'])
  return root
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isRepository', () => {
  it('is true inside a repo and false outside one', () => {
    expect(isRepository(makeRepo())).toBe(true)
    const bare = mkdtempSync(join(tmpdir(), 'prompt-lint-bare-'))
    expect(isRepository(bare)).toBe(false)
    rmSync(bare, { recursive: true, force: true })
  })
})

describe('the git subprocess environment', () => {
  it('ignores an inherited GIT_DIR, so the gate reads the repo it was pointed at (FR-043)', () => {
    // `prompt-lint` runs from `.husky/pre-commit`, where git has already set GIT_DIR,
    // GIT_WORK_TREE and GIT_INDEX_FILE. Inheriting them made every call resolve against
    // the hook's index instead of `cwd` — the gate silently read a different repository.
    const root = makeRepo()
    const other = makeRepo()

    vi.stubEnv('GIT_DIR', join(other, '.git'))
    vi.stubEnv('GIT_WORK_TREE', other)
    vi.stubEnv('GIT_INDEX_FILE', join(other, '.git/index'))

    const result = listAllFiles(root)
    expect(result.ok && result.value).toEqual(['AGENTS.md', 'keep.md'])
  })
})

describe('parseNameStatus', () => {
  it('separates added and modified from deleted', () => {
    expect(parseNameStatus('M\ta.md\nA\tb.md\nD\tc.md\n')).toEqual({
      changed: ['a.md', 'b.md'],
      deleted: ['c.md'],
    })
  })

  it('counts a rename’s old path as deleted — anything referencing it is now dangling', () => {
    expect(parseNameStatus('R100\told.md\tnew.md\n')).toEqual({
      changed: ['new.md'],
      deleted: ['old.md'],
    })
  })

  it('sorts both lists, so two runs report identically', () => {
    expect(parseNameStatus('M\tz.md\nM\ta.md\n').changed).toEqual(['a.md', 'z.md'])
  })

  it('ignores a malformed line rather than inventing a path', () => {
    expect(parseNameStatus('M\nrubbish\n\n')).toEqual({ changed: [], deleted: [] })
  })
})

describe('listAllFiles', () => {
  it('lists tracked files, sorted', () => {
    const result = listAllFiles(makeRepo())
    expect(result.ok && result.value).toEqual(['AGENTS.md', 'keep.md'])
  })

  it('includes untracked, non-ignored files — a new artifact is in scope before `git add`', () => {
    const root = makeRepo()
    write(root, '.gitignore', 'ignored.md\n')
    write(root, 'brand-new.md', '# new\n')
    write(root, 'ignored.md', '# build output\n')

    const result = listAllFiles(root)
    expect(result.ok && result.value).toContain('brand-new.md')
    expect(result.ok && result.value).not.toContain('ignored.md')
  })

  it('fails with a typed no-repo failure outside a repository', () => {
    const bare = mkdtempSync(join(tmpdir(), 'prompt-lint-bare-'))
    const result = listAllFiles(bare)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.kind).toBe('no-repo')
    rmSync(bare, { recursive: true, force: true })
  })
})

describe('listChangedFiles', () => {
  it('reports uncommitted work as changed, so a contributor sees it before committing', () => {
    const root = makeRepo()
    run(root, ['checkout', '-b', 'feature'])
    write(root, 'new.md', '# new\n')
    write(root, 'AGENTS.md', '# edited\n')

    const result = listChangedFiles(root, 'main')
    expect(result.ok && result.value.changed).toEqual(['AGENTS.md', 'new.md'])
  })

  it('reports a deleted file in `deleted`, which is what widens refs/dangling-path', () => {
    const root = makeRepo()
    run(root, ['checkout', '-b', 'feature'])
    rmSync(join(root, 'keep.md'))
    run(root, ['add', '-A'])
    run(root, ['commit', '-m', 'drop keep'])

    const result = listChangedFiles(root, 'main')
    expect(result.ok && result.value.deleted).toEqual(['keep.md'])
  })

  it('compares against the merge base, not the base ref’s tip', () => {
    // A base branch that moved on must not report its own commits as this branch's.
    const root = makeRepo()
    run(root, ['checkout', '-b', 'feature'])
    write(root, 'mine.md', '# mine\n')
    run(root, ['add', '-A'])
    run(root, ['commit', '-m', 'mine'])
    run(root, ['checkout', 'main'])
    write(root, 'theirs.md', '# theirs\n')
    run(root, ['add', '-A'])
    run(root, ['commit', '-m', 'theirs'])
    run(root, ['checkout', 'feature'])

    const result = listChangedFiles(root, 'main')
    expect(result.ok && result.value.changed).toEqual(['mine.md'])
  })

  it('fails with the ref named when the base ref cannot be resolved (exit 4, never an empty scope)', () => {
    // This is the failure the exit-code contract most needs: a shallow checkout that
    // silently evaluates zero artifacts and exits 0 (US2 §5).
    const result = listChangedFiles(makeRepo(), 'origin/does-not-exist')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe('unresolvable-ref')
      expect(result.failure.ref).toBe('origin/does-not-exist')
      expect(result.failure.message).toContain('origin/does-not-exist')
    }
  })

  it('fails when there is no merge base rather than reporting every file', () => {
    const root = makeRepo()
    run(root, ['checkout', '--orphan', 'unrelated'])
    write(root, 'other.md', '# other\n')
    run(root, ['add', '-A'])
    run(root, ['commit', '-m', 'unrelated root'])

    const result = listChangedFiles(root, 'main')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.kind).toBe('unresolvable-ref')
  })
})

describe('listStagedFiles', () => {
  it('reports only what is staged — the pre-commit path', () => {
    const root = makeRepo()
    write(root, 'staged.md', '# staged\n')
    write(root, 'unstaged.md', '# unstaged\n')
    run(root, ['add', 'staged.md'])

    const result = listStagedFiles(root)
    expect(result.ok && result.value.changed).toEqual(['staged.md'])
  })

  it('reports a staged deletion', () => {
    const root = makeRepo()
    run(root, ['rm', '--quiet', 'keep.md'])
    const result = listStagedFiles(root)
    expect(result.ok && result.value.deleted).toEqual(['keep.md'])
  })
})

describe('fileAtRef', () => {
  it('returns the content at that revision', () => {
    const root = makeRepo()
    write(root, 'AGENTS.md', '# edited\n')
    run(root, ['add', '-A'])
    run(root, ['commit', '-m', 'edit'])

    expect(fileAtRef(root, 'HEAD~1', 'AGENTS.md')).toBe('# base\n')
  })

  it('returns null for a path that did not exist there', () => {
    expect(fileAtRef(makeRepo(), 'HEAD', 'never.md')).toBeNull()
  })
})
