import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { AUDIT_PAGE_SIZE, AuditPanel } from './audit-panel'

/**
 * The panel holds two queries and a router push, so it cannot be rendered without a tRPC provider
 * and a query client, and there is no testing library in this app to drive it with. Its parts carry
 * the behavioural assertions: `audit-scope` covers every conversion between the URL, the draft and
 * the procedure's input; `grant-trail` covers the shaping; `grant-trail-card` and the reused
 * `role-change-history` cover what reaches the page.
 *
 * What is asserted here is what only the wiring can get wrong, and all of it is the **absence** of
 * something — which is why these are source-level properties rather than render assertions. An
 * audit view that grew a mutation, or that rendered a missing subject as a permission refusal,
 * would pass every other suite in this directory.
 */

const source = readFileSync(new URL('./audit-panel.tsx', import.meta.url), 'utf8')

/**
 * The source with its comments removed, so an assertion about what the component *says* is not
 * satisfied or defeated by prose explaining why it says it.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

describe('AuditPanel', () => {
  it('is a component the page can mount, taking both parsed scopes', () => {
    expect(typeof AuditPanel).toBe('function')
    expect(AuditPanel).toHaveLength(1)
    expect(source).toContain('initialConfigurationScope')
  })

  it('reads all three append-only trails the API surface mounts', () => {
    expect(source).toContain('api.admin.users.roleChanges.useInfiniteQuery')
    expect(source).toContain('api.admin.grants.listForUser.useQuery')
    // FR-178. The trail was written from the first bundle registration and read by nothing until
    // `admin.audit.list` existed; a screen that lost this query would be blind again.
    expect(source).toContain('api.admin.audit.list.useInfiniteQuery')
  })

  it('asks for the configuration trail unconditionally — there is no id to wait for', () => {
    // The subject-shaped trails are gated on an identifier. This one is the whole platform's, and
    // "everything, newest first" is the useful first answer rather than an empty screen.
    expect(source).not.toContain('enabled: hasConfigurationNarrowing')
  })

  it('keeps the configuration trail outside the missing-subject branch', () => {
    // A user id that does not exist says nothing about what was done to a setup bundle. Hiding the
    // whole screen behind one bad id would make a typo look like an audit with nothing in it.
    const [, afterBranch = ''] = source.split('<NotFoundCard message="No such user." />')

    expect(afterBranch).toContain('<ConfigurationTrailCard')
    expect(afterBranch).toContain('<ConfigurationFilters')
  })

  it('serialises both filters into one URL, so a copied link carries the whole screen', () => {
    expect(source).toContain('toAuditSearchParams')
    expect(source).toContain('toConfigurationSearchParams')
  })

  it('calls no mutation at all — the record is appended to, never edited (FR-177, FR-184)', () => {
    expect(source).not.toContain('useMutation')
    expect(source).not.toContain('.mutate')
  })

  it('renders a missing subject as not found, never as a permission refusal (FR-190)', () => {
    expect(source).toContain('isNotFoundError')
    expect(source).toContain('<NotFoundCard message="No such user." />')
    // The disclosure the NOT_FOUND code was chosen to prevent, put back by the UI. Checked against
    // the code rather than the file, so the comment explaining the rule does not trip it.
    expect(code).not.toMatch(/permission/i)
  })

  it('asks the server nothing until it has been given an identifier', () => {
    // `enabled` rather than a hidden card: an out-of-scope guess must not even be sent.
    expect(source).toContain('enabled: hasSubject(applied)')
  })

  it('reuses the existing role-and-activation history rather than a second copy', () => {
    expect(source).toContain('RoleChangeHistory')
    expect(source).toContain('components/admin/users/role-change-history')
  })

  it('pages the trail by cursor, so a change recorded while reading does not shift the page', () => {
    expect(source).toContain('getNextPageParam')
    expect(AUDIT_PAGE_SIZE).toBeGreaterThan(0)
  })
})
