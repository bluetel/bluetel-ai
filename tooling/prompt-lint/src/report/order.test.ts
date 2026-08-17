import { describe, expect, it } from 'vitest'

import type { Finding, RuleId, Severity } from '../rules/define'

import { compareFindings, countBySeverity, orderFindings } from './order'

const finding = (
  severity: Severity,
  path: string,
  line: number,
  rule: RuleId = 'a/b',
  message = 'm',
): Finding => ({
  rule,
  severity,
  path,
  line,
  message,
  remediation: 'fix it',
})

describe('orderFindings', () => {
  it('orders by severity descending, then path, then line, then rule', () => {
    const ordered = orderFindings([
      finding('note', 'a.md', 1),
      finding('error', 'b.md', 9),
      finding('warn', 'a.md', 2),
      finding('error', 'a.md', 5, 'z/z'),
      finding('error', 'a.md', 5, 'a/a'),
      finding('error', 'a.md', 1),
    ])
    expect(ordered.map((f) => `${f.severity}:${f.path}:${String(f.line)}:${f.rule}`)).toEqual([
      'error:a.md:1:a/b',
      'error:a.md:5:a/a',
      'error:a.md:5:z/z',
      'error:b.md:9:a/b',
      'warn:a.md:2:a/b',
      'note:a.md:1:a/b',
    ])
  })

  it('is total and stable: a shuffled input produces an identical output (SC-005)', () => {
    // The failure mode this guards is silent — a nearly-total ordering produces diffs
    // between two runs that look like real changes to the surface.
    const findings = [
      finding('error', 'a.md', 1, 'a/a', 'first'),
      finding('error', 'a.md', 1, 'a/a', 'second'),
      finding('warn', 'b.md', 3, 'b/b'),
      finding('note', 'c.md', 7, 'c/c'),
      finding('error', 'b.md', 1, 'a/a'),
    ]
    const canonical = JSON.stringify(orderFindings(findings))
    for (const rotation of [1, 2, 3, 4]) {
      const shuffled = [...findings.slice(rotation), ...findings.slice(0, rotation)]
      expect(JSON.stringify(orderFindings(shuffled))).toBe(canonical)
    }
  })

  it('does not mutate its input', () => {
    const findings = [finding('note', 'z.md', 1), finding('error', 'a.md', 1)]
    orderFindings(findings)
    expect(findings[0].severity).toBe('note')
  })

  it('compares two identical findings as equal', () => {
    expect(compareFindings(finding('warn', 'a.md', 1), finding('warn', 'a.md', 1))).toBe(0)
  })
})

describe('countBySeverity', () => {
  it('always reports all three keys, 0 rather than absent', () => {
    expect(countBySeverity([finding('error', 'a.md', 1)])).toEqual({ error: 1, warn: 0, note: 0 })
  })

  it('counts an empty list as three zeros', () => {
    expect(countBySeverity([])).toEqual({ error: 0, warn: 0, note: 0 })
  })
})
