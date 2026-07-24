import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  makeCatalog,
  makeTarget,
  parseActions,
  runSkills,
  snapshotBase,
  writeSkill,
} from './test-helpers'

const read = (target: string, name: string): string =>
  readFileSync(join(target, '.agents/skills', name, 'SKILL.md'), 'utf8')
const recordVersion = (target: string, name: string): string | undefined =>
  readFileSync(join(target, '.agents/skills', name, '.skill'), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('version='))
    ?.slice('version='.length)

describe('skills.sh update --on-conflict resolve', () => {
  it('non-overlapping local edit + bumped version → merge, both changes, record advanced, exit 0', () => {
    const target = makeTarget()
    const catalog = makeCatalog([
      {
        name: 'merging',
        version: '1.0.0',
        description: 'Merge.',
        files: { 'SKILL.md': 'line1\nline2\nline3\n' },
      },
    ])
    runSkills(['install', 'merging'], { catalog, target })

    // The base = content as originally installed.
    const base = snapshotBase(catalog, 'merging')

    // Local edit at the bottom; incoming edit at the top → non-overlapping.
    writeFileSync(join(target, '.agents/skills/merging/SKILL.md'), 'line1\nline2\nline3\nLOCAL\n')
    writeSkill(catalog, {
      name: 'merging',
      version: '1.1.0',
      description: 'Merge.',
      files: { 'SKILL.md': 'INCOMING\nline2\nline3\n' },
    })

    const res = runSkills(['update', 'merging', '--on-conflict', 'resolve'], {
      catalog,
      target,
      env: { SKILLS_BASE_DIR: base },
    })

    expect(res.status).toBe(0)
    expect(parseActions(res.stdout).find((a) => a.name === 'merging')?.action).toBe('merge')
    const merged = read(target, 'merging')
    expect(merged).toContain('INCOMING')
    expect(merged).toContain('LOCAL')
    expect(merged).not.toContain('<<<<<<<')
    expect(recordVersion(target, 'merging')).toBe('1.1.0')
  })

  it('overlapping edit → merge-conflict, markers present, record NOT advanced, exit 6', () => {
    const target = makeTarget()
    const catalog = makeCatalog([
      {
        name: 'merging',
        version: '1.0.0',
        description: 'Merge.',
        files: { 'SKILL.md': 'alpha\nbeta\ngamma\n' },
      },
    ])
    runSkills(['install', 'merging'], { catalog, target })
    const base = snapshotBase(catalog, 'merging')

    // Both sides edit the same middle line.
    writeFileSync(join(target, '.agents/skills/merging/SKILL.md'), 'alpha\nBETA-LOCAL\ngamma\n')
    writeSkill(catalog, {
      name: 'merging',
      version: '1.1.0',
      description: 'Merge.',
      files: { 'SKILL.md': 'alpha\nBETA-INCOMING\ngamma\n' },
    })

    const res = runSkills(['update', 'merging', '--on-conflict', 'resolve'], {
      catalog,
      target,
      env: { SKILLS_BASE_DIR: base },
    })

    expect(res.status).toBe(6)
    expect(parseActions(res.stdout).find((a) => a.name === 'merging')?.action).toBe(
      'merge-conflict',
    )
    const marked = read(target, 'merging')
    expect(marked).toContain('<<<<<<<')
    expect(marked).toContain('=======')
    expect(marked).toContain('>>>>>>>')
    expect(recordVersion(target, 'merging')).toBe('1.0.0') // not advanced
  })

  it('unobtainable base → merge unavailable, .incoming sidecar written, target not corrupted (FR-012b)', () => {
    const target = makeTarget()
    const catalog = makeCatalog([
      {
        name: 'merging',
        version: '1.0.0',
        description: 'Merge.',
        files: { 'SKILL.md': 'original\n' },
      },
    ])
    runSkills(['install', 'merging'], { catalog, target })

    const local = 'LOCALLY EDITED\n'
    writeFileSync(join(target, '.agents/skills/merging/SKILL.md'), local)
    writeSkill(catalog, {
      name: 'merging',
      version: '1.1.0',
      description: 'Merge.',
      files: { 'SKILL.md': 'incoming\n' },
    })

    // No SKILLS_BASE_DIR and a fixture catalog (not a git repo) → base unobtainable.
    const res = runSkills(['update', 'merging', '--on-conflict', 'resolve'], { catalog, target })

    expect(res.status).toBe(0)
    // Target content is not corrupted — the local edit survives.
    expect(read(target, 'merging')).toBe(local)
    // Incoming written to a sidecar for manual merge.
    const sidecar = join(target, '.agents/skills/merging/SKILL.md.incoming')
    expect(existsSync(sidecar)).toBe(true)
    expect(readFileSync(sidecar, 'utf8')).toBe('incoming\n')
  })
})
