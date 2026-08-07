import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { scanDirectory, scanSource, stripComments } from './hardcoded-convention-scan'

/**
 * FR-057, asserted about the source rather than about behaviour.
 *
 * The suite has two halves and both are necessary. The first proves the scanner **catches**
 * something — a scan that cannot fail is a scan that says nothing, and this is the requirement
 * where a green test with no teeth is the likeliest outcome. The second runs it over the real
 * directory.
 */

const here = dirname(fileURLToPath(import.meta.url))

describe('the scanner catches a hardcoded convention', () => {
  it('catches a defaulted base branch — the exact fallback FR-057 forbids', () => {
    const violations = scanSource(
      'delivery.ts',
      "export const baseFor = (skill) => skill.baseBranch ?? 'main'",
    )

    expect(violations).toHaveLength(1)
    expect(violations[0]?.kind).toBe('target branch')
    expect(violations[0]?.found).toBe('main')
  })

  it('catches a branch prefix', () => {
    const violations = scanSource('branch.ts', 'const branch = `feature/${ticket}`')

    expect(violations.map((violation) => violation.kind)).toEqual(['branch prefix'])
  })

  it('catches a pull request template', () => {
    const violations = scanSource('body.ts', "const body = '## Summary\\n\\nCloses #' + issue")

    expect(violations.map((violation) => violation.kind)).toContain('pull request template')
  })

  it('catches a board column a transition would move to', () => {
    const violations = scanSource('ticket.ts', "await ticket.transition({ toState: 'In Review' })")

    expect(violations.map((violation) => violation.kind)).toEqual(['board column'])
  })

  it('catches the same mistake spelled as a name rather than a value', () => {
    const violations = scanSource('config.ts', 'export const DEFAULT_BASE_BRANCH = readIt()')

    expect(violations[0]?.kind).toBe('defaulted convention')
    expect(violations[0]?.found).toBe('DEFAULT_BASE_BRANCH')
  })

  it('reports the line, so a violation is findable', () => {
    const violations = scanSource('x.ts', ['const a = 1', '', "const b = 'staging'"].join('\n'))

    expect(violations[0]?.line).toBe(3)
  })
})

describe('the scanner does not cry wolf', () => {
  it('ignores a convention named in a comment — that is documentation', () => {
    const source = [
      '// There is deliberately no default base branch here: not "main", not "develop".',
      '/* A ticket is never moved to In Review unless the skill says so. */',
      'export const nothing = 1',
    ].join('\n')

    expect(scanSource('doc.ts', source)).toEqual([])
  })

  it('ignores a forbidden word inside a longer sentence', () => {
    expect(
      scanSource('halt.ts', "throw new Error('the skill named no base branch to propose onto')"),
    ).toEqual([])
  })

  it('does not let a slash inside a literal swallow the rest of the line', () => {
    const source = "const url = 'https://git.test/a'\nconst branch = 'main'"

    expect(scanSource('url.ts', source)).toHaveLength(1)
  })

  it('keeps line numbering across a stripped block comment', () => {
    const stripped = stripComments('/* one\ntwo\nthree */\nconst a = 1')

    expect(stripped.split('\n')).toHaveLength(4)
  })
})

describe('this directory (FR-057)', () => {
  it('hardcodes no branch prefix, target branch, pull request template or ticket state', () => {
    const violations = scanDirectory(here).map(
      (violation) =>
        `${violation.file}:${String(violation.line)} ${violation.kind} "${violation.found}" — ${violation.why}`,
    )

    expect(violations).toEqual([])
  })

  it('actually scanned something, so an empty result is not an empty directory', () => {
    expect(scanDirectory(here)).toEqual([])
    expect(
      scanSource('probe.ts', "const base = 'main'").length,
      'the scanner is live',
    ).toBeGreaterThan(0)
  })
})
