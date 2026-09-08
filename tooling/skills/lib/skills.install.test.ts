import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { makeCatalog, makeTarget, parseActions, runSkills } from './test-helpers'

const CATALOG = [
  { name: 'merging', version: '1.2.0', description: 'Merge a feature branch into staging.' },
  { name: 'pr-creation', version: '2.0.1', description: 'Create a PR.', requires: ['merging'] },
]

describe('skills.sh install', () => {
  it('materializes content, stub, and record at the three expected paths (SC-002)', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()

    const res = runSkills(['install', 'merging'], { catalog, target })
    expect(res.status).toBe(0)

    expect(existsSync(join(target, '.agents/skills/merging/SKILL.md'))).toBe(true)
    expect(existsSync(join(target, '.agents/skills/merging/.skill'))).toBe(true)
    expect(existsSync(join(target, '.claude/skills/merging/SKILL.md'))).toBe(true)

    const record = readFileSync(join(target, '.agents/skills/merging/.skill'), 'utf8')
    expect(record).toMatch(/^version=1\.2\.0$/m)
    expect(record).toMatch(/^installed_hash=[0-9a-f]{64}$/m)
  })

  it('copies allowed-tools and disable-model-invocation from the canonical SKILL.md into the stub', () => {
    const catalog = makeCatalog([
      {
        name: 'fetch',
        version: '1.0.0',
        description: 'Read-only fetch.',
        files: {
          'SKILL.md':
            '---\nname: fetch\ndescription: Read-only fetch.\ndisable-model-invocation: true\nallowed-tools: Read, Bash(git status:*)\n---\n\n# fetch\n\nallowed-tools: this body line must not be copied\n',
        },
      },
    ])
    const target = makeTarget()

    expect(runSkills(['install', 'fetch'], { catalog, target }).status).toBe(0)

    const stub = readFileSync(join(target, '.claude/skills/fetch/SKILL.md'), 'utf8')
    const [frontmatter] = stub.split('\n---\n\n')
    expect(frontmatter).toContain('\ndisable-model-invocation: true\n')
    expect(frontmatter).toContain('\nallowed-tools: Read, Bash(git status:*)')
    expect(stub.match(/allowed-tools:/g)).toHaveLength(1)
  })

  it('writes nothing outside .agents and .claude (SC-002)', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()

    runSkills(['install', 'merging'], { catalog, target })

    const entries = readdirSync(target)
    expect(entries.sort()).toEqual(['.agents', '.claude'])
  })

  it('routes a second install to skip with exit 0 — no duplicate (SC-003)', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()

    runSkills(['install', 'merging'], { catalog, target })
    const res = runSkills(['install', 'merging'], { catalog, target })

    expect(res.status).toBe(0)
    const actions = parseActions(res.stdout)
    expect(actions).toEqual([{ name: 'merging', action: 'skip', version: '1.2.0' }])
  })

  it('transitively includes and reports required skills', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()

    const res = runSkills(['install', 'pr-creation'], { catalog, target })

    expect(res.status).toBe(0)
    expect(res.stdout).toContain('also installing required')
    expect(existsSync(join(target, '.agents/skills/merging/SKILL.md'))).toBe(true)
    expect(existsSync(join(target, '.agents/skills/pr-creation/SKILL.md'))).toBe(true)
    const actions = parseActions(res.stdout)
    expect(actions.find((a) => a.name === 'pr-creation')?.action).toBe('install')
    expect(actions.find((a) => a.name === 'merging')?.action).toBe('install')
  })
})
