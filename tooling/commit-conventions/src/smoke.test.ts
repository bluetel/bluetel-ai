import fs from 'node:fs'
import path from 'node:path'

import { describe, it, expect } from 'vitest'

// Repo root is three levels up from this file: src/ → commit-conventions/ → tooling/ → root
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

describe('Smoke tests: hook script structure', () => {
  // ---------------------------------------------------------------------------
  // 6.1 — package.json contains "prepare": "husky" in scripts
  // ---------------------------------------------------------------------------
  describe('package.json scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>
      'lint-staged': Record<string, string[]>
    }

    it('contains "prepare": "husky" in scripts', () => {
      expect(pkg.scripts).toBeDefined()
      expect(pkg.scripts.prepare).toBe('husky')
    })
  })

  // ---------------------------------------------------------------------------
  // 6.2 — package.json contains lint-staged key with correct globs and commands
  // ---------------------------------------------------------------------------
  describe('package.json lint-staged', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>
      'lint-staged': Record<string, string[]>
    }

    it('has a lint-staged configuration key', () => {
      expect(pkg['lint-staged']).toBeDefined()
    })

    it('eslint --flag v10_config_lookup_from_file --fix and prettier --write on JS/TS files', () => {
      const jsTsGlob = pkg['lint-staged']['**/*.{js,jsx,ts,tsx}']
      expect(jsTsGlob).toEqual([
        'node --max-old-space-size=8192 ./node_modules/.bin/eslint --flag v10_config_lookup_from_file --fix',
        'prettier --write',
      ])
    })

    it('runs prettier --write on JSON/YAML/MD files', () => {
      const otherGlob = pkg['lint-staged']['**/*.{json,yaml,yml,md}']
      expect(otherGlob).toEqual(['prettier --write'])
    })
  })

  // ---------------------------------------------------------------------------
  // 6.3 — .husky/pre-commit structure
  // ---------------------------------------------------------------------------
  describe('.husky/pre-commit', () => {
    const preCommitPath = path.join(REPO_ROOT, '.husky', 'pre-commit')
    const content = fs.readFileSync(preCommitPath, 'utf-8')

    it('exists on disk', () => {
      expect(fs.existsSync(preCommitPath)).toBe(true)
    })

    it('contains the NVM bootstrap snippet', () => {
      expect(content).toContain('export NVM_DIR="$HOME/.nvm"')
      expect(content).toContain('[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"')
    })

    it('contains npx lint-staged', () => {
      expect(content).toContain('npx lint-staged')
    })

    it('contains pnpm typecheck', () => {
      expect(content).toContain('pnpm typecheck')
    })

    it('runs npx lint-staged before pnpm typecheck', () => {
      const lintStagedIndex = content.indexOf('npx lint-staged')
      const typecheckIndex = content.indexOf('pnpm typecheck')
      expect(lintStagedIndex).toBeGreaterThan(-1)
      expect(typecheckIndex).toBeGreaterThan(-1)
      expect(lintStagedIndex).toBeLessThan(typecheckIndex)
    })

    it('does NOT contain --skip-nx-cache', () => {
      expect(content).not.toContain('--skip-nx-cache')
    })
  })

  // ---------------------------------------------------------------------------
  // 6.3a — .husky/pre-commit vitest-on-staged logic
  // ---------------------------------------------------------------------------
  describe('.husky/pre-commit vitest logic', () => {
    const preCommitPath = path.join(REPO_ROOT, '.husky', 'pre-commit')
    const content = fs.readFileSync(preCommitPath, 'utf-8')

    it('defines a find_project_root helper that walks up to the nearest vitest config', () => {
      expect(content).toContain('find_project_root()')
      expect(content).toContain('vitest.config.ts')
    })

    it('collects staged code files via git diff filtered to JS/TS extensions', () => {
      expect(content).toContain('git diff --cached --name-only --diff-filter=ACMR')
      expect(content).toMatch(/grep -E '\\\.\(ts\|tsx\|js\|jsx\)\$'/)
    })

    it('selects staged files that are themselves test files', () => {
      expect(content).toMatch(/grep -E '\\\.test\\\.\(ts\|tsx\|js\|jsx\)\$'/)
    })

    it('derives colocated test files from staged source files', () => {
      // Strips the staged file extension and probes for a `.test.<ext>` sibling.
      expect(content).toContain('base="${file%.*}"')
      expect(content).toContain('candidate="${base}.test.${ext}"')
      expect(content).toContain('[ -f "$candidate" ]')
    })

    it('de-duplicates the resolved test file list', () => {
      expect(content).toContain("sed '/^$/d' | sort -u")
    })

    it('groups test files by project and runs vitest from each project directory', () => {
      expect(content).toContain('cd "$root"')
      expect(content).toContain('pnpm exec vitest run')
    })

    it('fails the commit when a project test run fails', () => {
      expect(content).toContain('|| exit 1')
    })

    it('runs vitest after lint-staged but before pnpm typecheck', () => {
      const lintStagedIndex = content.indexOf('npx lint-staged')
      const vitestIndex = content.indexOf('pnpm exec vitest run')
      const typecheckIndex = content.indexOf('pnpm typecheck')
      expect(lintStagedIndex).toBeGreaterThan(-1)
      expect(vitestIndex).toBeGreaterThan(-1)
      expect(typecheckIndex).toBeGreaterThan(-1)
      expect(lintStagedIndex).toBeLessThan(vitestIndex)
      expect(vitestIndex).toBeLessThan(typecheckIndex)
    })
  })

  // ---------------------------------------------------------------------------
  // 6.4 — .husky/commit-msg structure
  // ---------------------------------------------------------------------------
  describe('.husky/commit-msg', () => {
    const commitMsgPath = path.join(REPO_ROOT, '.husky', 'commit-msg')
    const content = fs.readFileSync(commitMsgPath, 'utf-8')

    it('exists on disk', () => {
      expect(fs.existsSync(commitMsgPath)).toBe(true)
    })

    it('contains the NVM bootstrap snippet', () => {
      expect(content).toContain('export NVM_DIR="$HOME/.nvm"')
      expect(content).toContain('[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"')
    })

    it('delegates to tsx validate-commit-msg.ts', () => {
      expect(content).toContain('npx tsx tooling/commit-conventions/src/validate-commit-msg.ts')
    })
  })

  // ---------------------------------------------------------------------------
  // 6.5 — NVM bootstrap conditional form
  // ---------------------------------------------------------------------------
  describe('NVM bootstrap conditional form', () => {
    const preCommitContent = fs.readFileSync(path.join(REPO_ROOT, '.husky', 'pre-commit'), 'utf-8')
    const commitMsgContent = fs.readFileSync(path.join(REPO_ROOT, '.husky', 'commit-msg'), 'utf-8')

    it('pre-commit uses the conditional NVM source form', () => {
      expect(preCommitContent).toContain('[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"')
    })

    it('commit-msg uses the conditional NVM source form', () => {
      expect(commitMsgContent).toContain('[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"')
    })
  })
})
