import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { makeCatalog, makeTarget, readIfExists, runSkills } from './test-helpers'

const CATALOG = [{ name: 'pr-creation', version: '1.0.0', description: 'Create a pull request.' }]

/** Parse `config show` TSV (`KEY<TAB>VALUE<TAB>SOURCE`) into a lookup. */
const parseConfig = (stdout: string): Record<string, { value: string; source: string }> =>
  Object.fromEntries(
    stdout
      .split('\n')
      .filter((l) => l.includes('\t'))
      .map((l) => l.split('\t'))
      .filter((cols) => cols.length >= 3)
      .map(([key, value, source]) => [key, { value, source }]),
  )

describe('skills.sh config', () => {
  it('show returns built-in defaults on a clean target, marked as default', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()

    const res = runSkills(['config', 'show'], { catalog, target })

    expect(res.status).toBe(0)
    const cfg = parseConfig(res.stdout)
    expect(cfg.ticket_prefix).toEqual({ value: 'BTAI', source: 'default' })
    expect(cfg.branch_pattern.value).toBe('feature/{ticket}')
    expect(cfg.base_branch).toEqual({ value: 'main', source: 'default' })
    // No file is written just by reading.
    expect(existsSync(join(target, '.agents', 'skills.config'))).toBe(false)
  })

  it('get echoes a single effective value', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()

    const res = runSkills(['config', 'get', 'branch_pattern'], { catalog, target })

    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toBe('feature/{ticket}')
  })

  it('set writes overrides, preserves values with spaces, and keeps unset keys at default', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()

    const res = runSkills(
      ['config', 'set', 'ticket_prefix=PROJ', 'commit_format={ticket} - {description}'],
      { catalog, target },
    )
    expect(res.status).toBe(0)

    const cfg = parseConfig(runSkills(['config', 'show'], { catalog, target }).stdout)
    expect(cfg.ticket_prefix.value).toBe('PROJ')
    expect(cfg.commit_format.value).toBe('{ticket} - {description}')
    // An unset key keeps the built-in default value.
    expect(cfg.base_branch.value).toBe('main')

    // The file exists and is parseable line-by-line.
    const file = readIfExists(join(target, '.agents', 'skills.config'))
    expect(file).toContain('ticket_prefix=PROJ')
    expect(file).toContain('commit_format={ticket} - {description}')
  })

  it('set is idempotent and later overrides win', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()

    runSkills(['config', 'set', 'ticket_prefix=AAA'], { catalog, target })
    runSkills(['config', 'set', 'ticket_prefix=BBB', 'repo_owner=acme'], { catalog, target })

    const cfg = parseConfig(runSkills(['config', 'show'], { catalog, target }).stdout)
    expect(cfg.ticket_prefix.value).toBe('BBB')
    expect(cfg.repo_owner.value).toBe('acme')
  })

  it('rejects an unknown config key (usage error, exit 1) without writing', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()

    const res = runSkills(['config', 'set', 'not_a_key=x'], { catalog, target })

    expect(res.status).toBe(1)
    expect(res.stderr).toContain('unknown config key')
    expect(existsSync(join(target, '.agents', 'skills.config'))).toBe(false)
  })

  it('rejects an operand that is not key=value', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()

    const res = runSkills(['config', 'set', 'ticket_prefix'], { catalog, target })

    expect(res.status).toBe(1)
    expect(res.stderr).toContain('key=value')
  })

  describe('jira keys', () => {
    it('exposes jira keys, with no guessed default for board/epic', () => {
      const catalog = makeCatalog(CATALOG)
      const target = makeTarget()

      const cfg = parseConfig(runSkills(['config', 'show'], { catalog, target }).stdout)

      expect(cfg.jira_site.value).toBe('bluetel.atlassian.net')
      // No sensible cross-repo value — the skill must ask rather than guess.
      expect(cfg.jira_board_id.value).toBe('')
      expect(cfg.jira_epic_key.value).toBe('')
    })

    it('derives jira_project_key from ticket_prefix, and keeps tracking it after a write', () => {
      const catalog = makeCatalog(CATALOG)
      const target = makeTarget()

      expect(
        runSkills(['config', 'get', 'jira_project_key'], { catalog, target }).stdout.trim(),
      ).toBe('BTAI')

      // Setting only ticket_prefix must move the derived key with it — a previous
      // implementation materialized every key on write, freezing the derivation.
      runSkills(['config', 'set', 'ticket_prefix=ACME'], { catalog, target })
      expect(
        runSkills(['config', 'get', 'jira_project_key'], { catalog, target }).stdout.trim(),
      ).toBe('ACME')

      // A later unrelated write must not freeze it either.
      runSkills(['config', 'set', 'jira_board_id=42'], { catalog, target })
      runSkills(['config', 'set', 'ticket_prefix=THIRD'], { catalog, target })
      expect(
        runSkills(['config', 'get', 'jira_project_key'], { catalog, target }).stdout.trim(),
      ).toBe('THIRD')
    })

    it('lets an explicit jira_project_key override the derivation, and clearing restores it', () => {
      const catalog = makeCatalog(CATALOG)
      const target = makeTarget()

      runSkills(['config', 'set', 'ticket_prefix=ACME', 'jira_project_key=OTHER'], {
        catalog,
        target,
      })
      expect(
        runSkills(['config', 'get', 'jira_project_key'], { catalog, target }).stdout.trim(),
      ).toBe('OTHER')

      runSkills(['config', 'set', 'jira_project_key='], { catalog, target })
      expect(
        runSkills(['config', 'get', 'jira_project_key'], { catalog, target }).stdout.trim(),
      ).toBe('ACME')
    })

    it('writes only explicitly-set keys, never materializing defaults', () => {
      const catalog = makeCatalog(CATALOG)
      const target = makeTarget()

      runSkills(['config', 'set', 'jira_board_id=42'], { catalog, target })

      const file = readIfExists(join(target, '.agents', 'skills.config')) ?? ''
      expect(file).toContain('jira_board_id=42')
      // Untouched keys must be absent so they keep resolving to their default.
      expect(file).not.toContain('ticket_prefix=')
      expect(file).not.toContain('jira_project_key=')
      expect(file).not.toContain('jira_epic_key=')
    })

    it('succeeds when every remaining key is empty (guards a set -e regression)', () => {
      const catalog = makeCatalog(CATALOG)
      const target = makeTarget()

      // jira_epic_key is the last key and stays empty here; an earlier
      // `[ -n … ] && printf` made the whole write block exit non-zero.
      const res = runSkills(['config', 'set', 'ticket_prefix=SOLO'], { catalog, target })

      expect(res.status).toBe(0)
      expect(res.stdout).toContain('wrote')
    })
  })
})
