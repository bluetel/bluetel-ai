/* cspell:words issuetype */
import { describe, expect, it } from 'vitest'

import { parseJiraConfig, resolveJiraConfig } from './config'

const valid = {
  baseUrl: 'https://example.atlassian.net',
  projectPrefix: 'SIS',
  label: 'sisyphus',
}

describe('resolveJiraConfig', () => {
  it('settles the paging defaults so no caller has to know them', () => {
    const resolved = resolveJiraConfig(valid)

    expect(resolved.pageSize).toBe(50)
    expect(resolved.maxItemsPerTick).toBe(500)
  })

  it('rejects a plaintext base URL', () => {
    // The credential travels on every request to it.
    expect(() => resolveJiraConfig({ ...valid, baseUrl: 'http://example.atlassian.net' })).toThrow()
  })

  it('rejects a page size above what Jira will honour', () => {
    expect(() => resolveJiraConfig({ ...valid, pageSize: 250 })).toThrow()
  })

  it('rejects an extra filter it cannot express, rather than ignoring it', () => {
    // Ignoring an unrecognised filter would widen the query: tickets an admin believed were
    // excluded would start paid runs. Failing the tick is recoverable; over-broad discovery is not.
    const result = parseJiraConfig({ ...valid, extraFilters: { status: { in: ['Ready'] } } })

    expect(result.success).toBe(false)
  })

  it('accepts a single value or a set for an extra filter', () => {
    const resolved = resolveJiraConfig({
      ...valid,
      extraFilters: { status: 'Ready', issuetype: ['Bug', 'Task'] },
    })

    expect(resolved.extraFilters).toEqual({ status: 'Ready', issuetype: ['Bug', 'Task'] })
  })

  it('treats the service account as optional', () => {
    expect(resolveJiraConfig(valid).serviceAccount).toBeUndefined()
    expect(
      resolveJiraConfig({ ...valid, serviceAccount: { accountId: 'a' } }).serviceAccount,
    ).toEqual({ accountId: 'a' })
  })

  it('requires the project prefix and the label, since both bound what may be started', () => {
    expect(parseJiraConfig({ ...valid, projectPrefix: '' }).success).toBe(false)
    expect(parseJiraConfig({ ...valid, label: '' }).success).toBe(false)
  })

  it('has nowhere to put a credential', () => {
    const resolved: Record<string, unknown> = { ...resolveJiraConfig(valid) }

    expect(Object.keys(resolved)).not.toContain('apiToken')
    expect(Object.keys(resolved)).not.toContain('credential')
  })
})
