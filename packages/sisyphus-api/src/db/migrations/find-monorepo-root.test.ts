import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { findMonorepoRoot } from './find-monorepo-root'

describe('findMonorepoRoot', () => {
  it('finds the root from a deeply nested directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'monorepo-root-'))
    try {
      writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
      const nested = path.join(root, 'packages', 'sisyphus-api', 'src', 'db', 'migrations')

      expect(findMonorepoRoot(nested)).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('finds the root from the root itself', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'monorepo-root-'))
    try {
      writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')

      expect(findMonorepoRoot(root)).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('throws when no marker is found above the starting directory', () => {
    const orphan = mkdtempSync(path.join(tmpdir(), 'not-a-monorepo-'))
    try {
      expect(() => findMonorepoRoot(orphan)).toThrow(/pnpm-workspace\.yaml/)
    } finally {
      rmSync(orphan, { recursive: true, force: true })
    }
  })
})
