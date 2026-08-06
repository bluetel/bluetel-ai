import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { workflowEntries } from '../../db'
import { reportEntryResultInput } from '../../schemas'
import type { MachineCredential } from '../context'

import { reportEntryResult } from './entry-results'
import type { MachineFixture } from './test-support'
import { createMachineFixture, readTestDatabaseUrl, refusalOf } from './test-support'

/**
 * `reportEntryResult` — the per-repository outcome, written against an entry of the credential's
 * own run and no other (FR-114, FR-115, FR-118, FR-018, SC-014).
 */

const connectionString = readTestDatabaseUrl()

/**
 * The staleness assessment is reachable through the procedure at all — which it was not, and which
 * is why `apps/sisyphus-executor/src/delivery/staleness.ts` records it as a stored `report`
 * artifact instead. Asserted without a database because it is a property of the input schema.
 */
describe('the staleness assessment on the entry-result payload (FR-079)', () => {
  const base = {
    entryId: '01890a5d-ac96-774b-bcce-b302099a8057',
    resolvedCommit: 'a'.repeat(40),
    wasChanged: true,
    entryResult: 'landed',
  }

  it('accepts a note', () => {
    const parsed = reportEntryResultInput.parse({ ...base, stalenessNote: 'main advanced.' })

    expect(parsed.stalenessNote).toBe('main advanced.')
  })

  it('accepts no note at all — a run that never assessed staleness reports none', () => {
    expect(reportEntryResultInput.parse(base).stalenessNote).toBeUndefined()
  })

  it('refuses an empty note, which would record an assessment that says nothing', () => {
    expect(() => reportEntryResultInput.parse({ ...base, stalenessNote: '   ' })).toThrow()
  })
})

describe.skipIf(connectionString === undefined)('reportEntryResult', () => {
  let fixture: MachineFixture
  let credential: MachineCredential

  beforeAll(async () => {
    fixture = createMachineFixture(connectionString ?? '')
    await fixture.open()
    credential = await fixture.seedCredential(fixture.ids().a.workflowId)
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  it('records a landed entry with its commit and pull request', async () => {
    const { ctx } = fixture.contextFor(credential)

    const report = await reportEntryResult(ctx, {
      entryId: fixture.ids().a.workflowEntryId,
      resolvedCommit: 'a'.repeat(40),
      wasChanged: true,
      pullRequestUrl: 'https://git.test/a/pull/12',
      entryResult: 'landed',
      stalenessNote: 'main is still at abc123456789, the commit this run checked out.',
    })

    expect(report.recorded).toBe(true)
    expect(report.entry.workflowId).toBe(fixture.ids().a.workflowId)
    expect(report.entry.entryResult).toBe('landed')
    expect(report.entry.wasChanged).toBe(true)
    expect(report.entry.pullRequestUrl).toBe('https://git.test/a/pull/12')
    expect(report.entry.resolvedCommit).toBe('a'.repeat(40))
    // FR-079: the assessment lands on the entry it is about, in the same write as the result.
    expect(report.entry.stalenessNote).toBe(
      'main is still at abc123456789, the commit this run checked out.',
    )
  })

  it('keeps the first result on a retry, and answers rather than raising (FR-047)', async () => {
    const { ctx } = fixture.contextFor(credential)

    const report = await reportEntryResult(ctx, {
      entryId: fixture.ids().a.workflowEntryId,
      resolvedCommit: 'a'.repeat(40),
      wasChanged: true,
      pullRequestUrl: 'https://git.test/a/pull/12',
      entryResult: 'landed',
    })

    expect(report.recorded).toBe(false)
    expect(report.entry.entryResult).toBe('landed')
    // The retry carried no `stalenessNote`, and omitting one leaves the column alone rather than
    // clearing it: absent means "not assessed", not "assessed as nothing".
    expect(report.entry.stalenessNote).toBe(
      'main is still at abc123456789, the commit this run checked out.',
    )
  })

  it('never overwrites the recorded pull request — at most one per entry (FR-115)', async () => {
    const { ctx } = fixture.contextFor(credential)

    await reportEntryResult(ctx, {
      entryId: fixture.ids().a.workflowEntryId,
      resolvedCommit: 'b'.repeat(40),
      wasChanged: true,
      pullRequestUrl: 'https://git.test/a/pull/99',
      entryResult: 'failed',
      stalenessNote: 'main advanced by forty commits during this run.',
    })

    const rows = await fixture
      .db()
      .select()
      .from(workflowEntries)
      .where(eq(workflowEntries.id, fixture.ids().a.workflowEntryId))

    expect(rows[0]?.pullRequestUrl).toBe('https://git.test/a/pull/12')
    expect(rows[0]?.entryResult).toBe('landed')
    // First result wins for the assessment too — a later report cannot rewrite what the run
    // observed about the base branch at the moment it finished.
    expect(rows[0]?.stalenessNote).toBe(
      'main is still at abc123456789, the commit this run checked out.',
    )
  })

  it('refuses an entry belonging to another workflow, and records it (FR-018, SC-014)', async () => {
    const { ctx, denials } = fixture.contextFor(credential)

    await expect(
      reportEntryResult(ctx, {
        entryId: fixture.ids().b.workflowEntryId,
        resolvedCommit: 'c'.repeat(40),
        wasChanged: true,
        entryResult: 'landed',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    expect(denials).toHaveLength(1)
    expect(denials[0]).toMatchObject({
      reason: 'cross_workflow_write',
      workflowId: fixture.ids().a.workflowId,
      path: 'machine.reportEntryResult',
    })
  })

  it('writes nothing to the other workflow’s entry when the check refuses', async () => {
    const rows = await fixture
      .db()
      .select()
      .from(workflowEntries)
      .where(eq(workflowEntries.id, fixture.ids().b.workflowEntryId))

    expect(rows[0]?.entryResult).toBeNull()
    expect(rows[0]?.pullRequestUrl).toBeNull()
  })

  it('refuses an unknown entry identically, so it is not an id oracle (FR-190)', async () => {
    const crossWorkflow = fixture.contextFor(credential)
    const unknown = fixture.contextFor(credential)

    const forOtherRun = await refusalOf(() =>
      reportEntryResult(crossWorkflow.ctx, {
        entryId: fixture.ids().b.workflowEntryId,
        resolvedCommit: 'd'.repeat(40),
        wasChanged: false,
        entryResult: 'unchanged',
      }),
    )
    const forUnknown = await refusalOf(() =>
      reportEntryResult(unknown.ctx, {
        entryId: randomUUID(),
        resolvedCommit: 'd'.repeat(40),
        wasChanged: false,
        entryResult: 'unchanged',
      }),
    )

    expect(forOtherRun.code).toBe(forUnknown.code)
    expect(forOtherRun.message).toBe(forUnknown.message)
  })
})
