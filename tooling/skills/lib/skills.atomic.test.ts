import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { makeCatalog, makeTarget, runSkills } from './test-helpers'

describe('skills.sh atomicity (SC-005)', () => {
  it('a write forced to fail mid-run leaves the target byte-for-byte unchanged and exits 4', () => {
    const catalog = makeCatalog([
      { name: 'merging', version: '1.0.0', description: 'Merge.' },
      { name: 'review', version: '1.0.0', description: 'Review.' },
    ])
    const target = makeTarget()

    // Install merging cleanly first; capture its exact bytes.
    runSkills(['install', 'merging'], { catalog, target })
    const before = readFileSync(join(target, '.agents/skills/merging/SKILL.md'), 'utf8')

    // Now install review + (re)merging with an injected failure after review is written.
    // Rollback must remove review AND leave merging untouched.
    const res = runSkills(['install', 'review'], {
      catalog,
      target,
      env: { SKILLS_FAIL_AFTER: 'review' },
    })

    expect(res.status).toBe(4)
    // The skill written this invocation was rolled back.
    expect(existsSync(join(target, '.agents/skills/review'))).toBe(false)
    expect(existsSync(join(target, '.claude/skills/review'))).toBe(false)
    // The previously-installed skill is byte-for-byte unchanged.
    expect(readFileSync(join(target, '.agents/skills/merging/SKILL.md'), 'utf8')).toBe(before)
  })
})

describe('skills.sh missing hash tool (FR-013/FR-014)', () => {
  it('exits 5 with guidance when neither sha256sum nor shasum is on PATH', () => {
    const catalog = makeCatalog([{ name: 'merging', version: '1.0.0', description: 'Merge.' }])
    const target = makeTarget()

    // Build a minimal PATH with the core utilities but WITHOUT any sha256 tool.
    const shim = makeTarget() // reuse as a throwaway bin dir
    const needed = [
      'sh',
      'find',
      'sort',
      'awk',
      'sed',
      'cut',
      'mkdir',
      'cp',
      'mv',
      'rm',
      'cat',
      'date',
      'basename',
      'dirname',
      'grep',
      'git',
    ]
    const origPath = process.env.PATH ?? ''
    for (const tool of needed) {
      const found = origPath
        .split(delimiter)
        .map((d) => join(d, tool))
        .find((p) => existsSync(p))
      if (found) {
        const link = join(shim, tool)
        writeFileSync(link, `#!/bin/sh\nexec "${found}" "$@"\n`, { mode: 0o755 })
      }
    }

    const res = runSkills(['install', 'merging'], {
      catalog,
      target,
      env: { PATH: shim },
    })

    expect(res.status).toBe(5)
    expect(res.stderr).toMatch(/sha256sum|shasum/)
  })
})
