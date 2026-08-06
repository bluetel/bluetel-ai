/* cspell:ignore ilike */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DatabaseClient } from '../../db'
import { createDatabaseClient, workflows } from '../../db'
import { listWorkflowsInput } from '../../schemas'
import type { ResolvedScope } from '../scope'
import { scopedWorkflowWhere } from '../scope'

import { escapeSearchTerm, toWorkflowPage, workflowListConditions } from './filters'

/**
 * The list's `where` fragments, inspected as SQL. No database is contacted — `toSQL()` compiles a
 * query without executing it, so these run everywhere; whether the predicates *mean* what they say
 * is settled against a real Postgres in `queries.test.ts`.
 */

const scopeOf = (overrides: Partial<ResolvedScope> = {}): ResolvedScope => ({
  userId: '11111111-1111-7111-8111-111111111111',
  isAdmin: false,
  visibleProfileIds: [],
  ...overrides,
})

const ID = '22222222-2222-7222-8222-222222222222'

describe('escapeSearchTerm', () => {
  it('neutralises the two pattern wildcards', () => {
    // Unescaped, a search for `100%` matches every row — including rows the caller may not see.
    expect(escapeSearchTerm('100%')).toBe('100\\%')
    expect(escapeSearchTerm('a_b')).toBe('a\\_b')
  })

  it('doubles the escape character first, so it cannot escape the escaping', () => {
    expect(escapeSearchTerm('a\\%')).toBe('a\\\\\\%')
  })

  it('leaves an ordinary term alone', () => {
    expect(escapeSearchTerm('PROJ-1234')).toBe('PROJ-1234')
  })
})

describe('toWorkflowPage', () => {
  it('returns no cursor when the over-fetch found nothing extra', () => {
    expect(toWorkflowPage([{ id: 'a' }, { id: 'b' }], 2)).toStrictEqual({
      items: [{ id: 'a' }, { id: 'b' }],
      nextCursor: undefined,
    })
  })

  it('drops the extra row and hands back the last id it kept', () => {
    // The cursor must be a row the caller has been shown; handing back the discarded row's id
    // would skip it on the next page.
    expect(toWorkflowPage([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 2)).toStrictEqual({
      items: [{ id: 'a' }, { id: 'b' }],
      nextCursor: 'b',
    })
  })

  it('handles an empty result set', () => {
    expect(toWorkflowPage([], 10)).toStrictEqual({ items: [], nextCursor: undefined })
  })
})

describe('workflowListConditions', () => {
  let client: DatabaseClient

  beforeAll(() => {
    client = createDatabaseClient({ connectionString: 'postgres://compile-only@127.0.0.1:1/none' })
  })

  afterAll(async () => {
    await client.close()
  })

  const compile = (filters: Record<string, unknown>): string =>
    client.db
      .select()
      .from(workflows)
      .where(
        scopedWorkflowWhere(
          scopeOf(),
          workflowListConditions(client.db, listWorkflowsInput.parse(filters)),
        ),
      )
      .toSQL().sql

  it('restricts to the scope even when nothing is filtered', () => {
    const sql = compile({})

    expect(sql).toContain('"owner_user_id" =')
    expect(sql).toContain('"initiated_by_user_id" =')
  })

  it('keeps the scope clause in front of every filter', () => {
    const sql = compile({ state: ['running'], ownerUserId: ID })

    // The scope predicate and the caller's own predicate are both present; a filter narrows, it
    // never replaces.
    expect(sql).toContain('"initiated_by_user_id" =')
    expect(sql).toContain('"state" in')
  })

  it('paginates by keyset on the primary key, never by offset', () => {
    const sql = compile({ cursor: ID })

    expect(sql).toContain('"id" <')
    expect(sql).not.toContain('offset')
  })

  it('resolves the workspace filter through workspace versions rather than joining', () => {
    const sql = compile({ workspaceId: ID })

    expect(sql).toContain('"workspace_version_id" in')
    expect(sql).toContain('"workspace_versions"')
  })

  it('resolves the setup bundle filter through bundle versions', () => {
    const sql = compile({ setupBundleId: ID })

    expect(sql).toContain('"setup_bundle_version_id" in')
    expect(sql).toContain('"setup_bundle_versions"')
  })

  it('matches a repository with exists, so a multi-repo run cannot appear twice', () => {
    const sql = compile({ repositoryUrl: 'https://git.test/a.git' })

    expect(sql).toContain('exists')
    expect(sql).toContain('"workflow_entries"')
  })

  it('searches the short identifiers and never the assembled prompt', () => {
    const sql = compile({ search: 'PROJ-1' })

    expect(sql).toContain('"ticket_reference" ilike')
    expect(sql).toContain('"result_branch_name" ilike')
    // Unbounded text with no index: including it would make every search a sequential scan.
    expect(sql).not.toContain('"assembled_prompt" ilike')
  })

  it('composes every filter at once without dropping the scope', () => {
    const sql = compile({
      cursor: ID,
      initiatedByUserId: ID,
      ownerUserId: ID,
      originatingIntegrationId: ID,
      executionProfileId: ID,
      setupBundleId: ID,
      workspaceId: ID,
      repositoryUrl: 'https://git.test/a.git',
      type: 'delegated',
      state: ['running', 'paused'],
      search: 'PROJ-1',
    })

    expect(sql).toContain('"owner_user_id" =')
    expect(sql).toContain('"originating_integration_id" =')
    expect(sql).toContain('"execution_profile_id" =')
    expect(sql).toContain('"type" =')
  })
})
