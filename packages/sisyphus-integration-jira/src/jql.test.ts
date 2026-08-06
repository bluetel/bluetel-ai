/* cspell:words issuekey issuetype */
import { describe, expect, it } from 'vitest'

import { resolveJiraConfig } from './config'
import { buildDiscoveryJql, escapeJqlValue, jqlClause, jqlField } from './jql'

const config = (overrides: Record<string, unknown> = {}) =>
  resolveJiraConfig({
    baseUrl: 'https://example.atlassian.net',
    projectPrefix: 'SIS',
    label: 'sisyphus',
    ...overrides,
  })

describe('buildDiscoveryJql', () => {
  it('scopes to the project and the label that marks a ticket for delivery', () => {
    expect(buildDiscoveryJql(config())).toBe(
      'project = "SIS" AND labels = "sisyphus" ORDER BY created ASC, issuekey ASC',
    )
  })

  it('orders the result set, so paging by offset cannot skip a ticket', () => {
    // Without this, page two of an unordered query may repeat page one and drop what should have
    // been on it — a matching ticket lost from the tick entirely (FR-108).
    expect(buildDiscoveryJql(config())).toContain('ORDER BY created ASC, issuekey ASC')
  })

  it('appends extra filters in a fixed order, so the same configuration builds the same query', () => {
    const jql = buildDiscoveryJql(
      config({ extraFilters: { status: ['Ready', 'To Do'], issuetype: 'Bug' } }),
    )

    expect(jql).toBe(
      'project = "SIS" AND labels = "sisyphus" AND issuetype = "Bug" ' +
        'AND status IN ("Ready", "To Do") ORDER BY created ASC, issuekey ASC',
    )
  })

  it('cannot be widened by a label that closes the quote', () => {
    // The attack, and the reason escaping is here at all: an unescaped label of this shape
    // silently scopes discovery to somebody else's project, and every ticket it returns becomes a
    // candidate the control plane will start paid compute for.
    const jql = buildDiscoveryJql(config({ label: 'x" OR project = "OTHER' }))

    // The whole injection stays inside the quoted label value, where it is a label nobody has.
    expect(jql).toBe(
      'project = "SIS" AND labels = "x\\" OR project = \\"OTHER" ' +
        'ORDER BY created ASC, issuekey ASC',
    )
    expect(jql).not.toContain('OR project = "OTHER"')
  })

  it('escapes a project key that tries the same thing', () => {
    expect(buildDiscoveryJql(config({ projectPrefix: 'A" OR labels = "x' }))).toContain(
      'project = "A\\" OR labels = \\"x"',
    )
  })
})

describe('escapeJqlValue', () => {
  it('neutralises quotes, backslashes and line breaks', () => {
    expect(escapeJqlValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd')
  })

  it('escapes the backslash before the quote, so an escaped quote cannot be re-opened', () => {
    expect(escapeJqlValue('\\"')).toBe('\\\\\\"')
  })
})

describe('jqlField', () => {
  it('leaves an ordinary field name bare', () => {
    expect(jqlField('status')).toBe('status')
    expect(jqlField('cf[10001]')).toBe('cf[10001]')
  })

  it('quotes a custom field name with spaces, and escapes it', () => {
    expect(jqlField('Client Team')).toBe('"Client Team"')
    expect(jqlField('a" OR x = "')).toBe('"a\\" OR x = \\""')
  })
})

describe('jqlClause', () => {
  it('uses equality for one value and membership for several', () => {
    expect(jqlClause('status', 'Ready')).toBe('status = "Ready"')
    expect(jqlClause('status', ['Ready'])).toBe('status = "Ready"')
    expect(jqlClause('status', ['Ready', 'Doing'])).toBe('status IN ("Ready", "Doing")')
  })
})
