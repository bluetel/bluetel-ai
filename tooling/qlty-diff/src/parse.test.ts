import { describe, expect, it } from 'vitest'

import {
  countClusters,
  extractResults,
  linesOf,
  locationOf,
  parseTotalLines,
  stripAnsi,
  type SarifResult,
} from './parse'

describe('extractResults', () => {
  it('slices SARIF from log-prefixed output and returns the results', () => {
    const raw = `some log line\n{"runs":[{"results":[{"ruleId":"a"},{"ruleId":"b"}]}]}`
    expect(extractResults(raw, 'check')).toEqual([{ ruleId: 'a' }, { ruleId: 'b' }])
  })

  it('returns an empty array when a run has no results', () => {
    expect(extractResults('{"runs":[{}]}', 'smells')).toEqual([])
  })

  it('throws when there is no JSON at all', () => {
    expect(() => extractResults('command not found', 'check')).toThrow(/no SARIF output/)
  })
})

describe('stripAnsi', () => {
  it('removes color escape codes', () => {
    const esc = String.fromCharCode(27)
    const word = 'red'
    expect(stripAnsi(`${esc}[31m${word}${esc}[0m`)).toBe(word)
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsi('just text')).toBe('just text')
  })
})

describe('linesOf', () => {
  it('reads the line count out of a duplication message', () => {
    expect(linesOf({ message: { text: 'Found 42 lines of duplicated code' } })).toBe(42)
  })

  it('returns 0 when no count is present', () => {
    expect(linesOf({ message: { text: 'no numbers here' } })).toBe(0)
    expect(linesOf({})).toBe(0)
  })
})

describe('countClusters', () => {
  it('collapses results that share a structural hash', () => {
    const results: SarifResult[] = [
      { properties: { structural_hash: 'x' } },
      { properties: { structural_hash: 'x' } },
      { properties: { structural_hash: 'y' } },
    ]
    expect(countClusters(results)).toBe(2)
  })

  it('falls back to locations when no hash is present', () => {
    const results: SarifResult[] = [
      { locations: [{ physicalLocation: { artifactLocation: { uri: 'a.ts' } } }] },
      { locations: [{ physicalLocation: { artifactLocation: { uri: 'b.ts' } } }] },
    ]
    expect(countClusters(results)).toBe(2)
  })
})

describe('locationOf', () => {
  it('returns the artifact uri', () => {
    expect(
      locationOf({ locations: [{ physicalLocation: { artifactLocation: { uri: 'src/a.ts' } } }] }),
    ).toBe('src/a.ts')
  })

  it('returns ? when no location is present', () => {
    expect(locationOf({})).toBe('?')
  })
})

describe('parseTotalLines', () => {
  it('reads the lines column from the TOTAL row', () => {
    const metrics = [
      'Name | classes | functions | fields | complexity | cognitive | code | lines',
      'src/a.ts | 0 | 2 | 0 | 3 | 4 | 30 | 40',
      'TOTAL | 0 | 5 | 0 | 9 | 12 | 90 | 120',
    ].join('\n')
    expect(parseTotalLines(metrics)).toBe(120)
  })

  it('returns 0 when there is no TOTAL row', () => {
    expect(parseTotalLines('no total here')).toBe(0)
  })
})
