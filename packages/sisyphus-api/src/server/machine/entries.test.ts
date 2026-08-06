import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { WorkflowEntry } from '../../db'
import { workflowEntries } from '../../db'
import type { MachineCredential } from '../context'

import {
  honestTerminalOutcome,
  loadEntryStandings,
  reportEntryCheckout,
  reportEntryCheckoutInput,
  summariseEntryResults,
} from './entries'
import type { MachineFixture } from './test-support'
import { createMachineFixture, readTestDatabaseUrl, refusalOf } from './test-support'

/**
 * The two clauses `reportEntryResult` does not reach: FR-114's *at checkout time*, and FR-118's
 * *must not report plain success*.
 */

const connectionString = readTestDatabaseUrl()

/** A `workflow_entries` row, only as much of one as the aggregate reads. */
const row = (repositoryUrl: string, entryResult: WorkflowEntry['entryResult']): WorkflowEntry =>
  ({
    id: randomUUID(),
    repositoryUrl,
    entryResult,
  }) as WorkflowEntry

describe('the checkout payload', () => {
  const base = { entryId: randomUUID(), resolvedCommit: 'a'.repeat(40) }

  it('carries no result, so it cannot pre-empt reportEntryResult', () => {
    const parsed = reportEntryCheckoutInput.parse({ ...base, entryResult: 'landed' })

    expect('entryResult' in parsed).toBe(false)
  })

  it('refuses a checkout with no commit — an unrecorded pin is the thing FR-114 forbids', () => {
    expect(() => reportEntryCheckoutInput.parse({ entryId: base.entryId })).toThrow()
    expect(() => reportEntryCheckoutInput.parse({ ...base, resolvedCommit: '  ' })).toThrow()
  })

  it('accepts a staleness note assessed at checkout, and none at all', () => {
    expect(reportEntryCheckoutInput.parse(base).stalenessNote).toBeUndefined()
    expect(
      reportEntryCheckoutInput.parse({ ...base, stalenessNote: 'main advanced.' }).stalenessNote,
    ).toBe('main advanced.')
  })
})

describe('summariseEntryResults (FR-118)', () => {
  it('counts a whole set that landed as no shortfall at all', () => {
    const summary = summariseEntryResults([row('api', 'landed'), row('web', 'landed')])

    expect(summary).toMatchObject({ landed: 2, failed: 0, pending: 0, isPartial: false })
    expect(summary.forbidsPlainSuccess).toBe(false)
  })

  it('does not count an untouched repository against the run', () => {
    // The agent changed the API and had no reason to touch the web app. That is a finished run,
    // not a half-done one.
    const summary = summariseEntryResults([row('api', 'landed'), row('web', 'unchanged')])

    expect(summary).toMatchObject({ landed: 1, unchanged: 1, isPartial: false })
    expect(summary.forbidsPlainSuccess).toBe(false)
  })

  it('reports one landed beside one failed as partial', () => {
    const summary = summariseEntryResults([row('api', 'landed'), row('web', 'failed')])

    expect(summary.isPartial).toBe(true)
    expect(summary.forbidsPlainSuccess).toBe(true)
  })

  it('counts an entry nobody reported on as a shortfall, not as silence', () => {
    // The run died before it reached the third repository. Nothing failed, and nothing is fine.
    const summary = summariseEntryResults([row('api', 'landed'), row('web', null)])

    expect(summary).toMatchObject({ pending: 1, isPartial: true, forbidsPlainSuccess: true })
  })

  it('is a failure rather than a partial result when nothing landed', () => {
    const summary = summariseEntryResults([row('api', 'failed'), row('web', 'failed')])

    expect(summary.isPartial).toBe(false)
    expect(summary.forbidsPlainSuccess).toBe(true)
  })

  it('names every repository and what happened to it', () => {
    const summary = summariseEntryResults([
      row('https://git.test/acme/api', 'landed'),
      row('https://git.test/acme/web', 'failed'),
    ])

    expect(summary.statement).toContain('https://git.test/acme/api: landed')
    expect(summary.statement).toContain('https://git.test/acme/web: failed')
  })

  it('leaves the single-entry run, the common case, exactly as it was', () => {
    expect(summariseEntryResults([row('api', 'landed')])).toMatchObject({
      isPartial: false,
      forbidsPlainSuccess: false,
    })
  })
})

describe('honestTerminalOutcome (FR-118)', () => {
  const partial = summariseEntryResults([row('api', 'landed'), row('web', 'failed')])
  const whole = summariseEntryResults([row('api', 'landed'), row('web', 'landed')])

  it('lets a genuine success through untouched', () => {
    expect(honestTerminalOutcome(whole, 'succeeded')).toEqual({
      outcome: 'succeeded',
      substituted: false,
      reason: '',
    })
  })

  it('refuses plain success over a partial result', () => {
    const decided = honestTerminalOutcome(partial, 'succeeded')

    expect(decided.outcome).toBe('needs_attention')
    expect(decided.substituted).toBe(true)
  })

  it('states the partial result rather than only refusing it', () => {
    const decided = honestTerminalOutcome(partial, 'succeeded')

    expect(decided.reason).toContain('1 of 2 repositories landed')
    expect(decided.reason).toContain('api: landed')
    expect(decided.reason).toContain('web: failed')
  })

  it('does not overwrite an outcome that already says something specific', () => {
    // `failed`, `capped` and `cancelled` are all true statements about a run that did not plainly
    // succeed. Replacing one with `needs_attention` would trade a specific truth for a vaguer one.
    for (const requested of ['failed', 'capped', 'cancelled', 'parked_resumable'] as const) {
      expect(honestTerminalOutcome(partial, requested)).toMatchObject({
        outcome: requested,
        substituted: false,
      })
    }
  })

  it('refuses success for a run that reported on none of its repositories', () => {
    const nothing = summariseEntryResults([row('api', null), row('web', null)])

    expect(honestTerminalOutcome(nothing, 'succeeded').outcome).toBe('needs_attention')
  })
})

describe.skipIf(connectionString === undefined)(
  'reportEntryCheckout against a live database',
  () => {
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

    const entryRow = async (entryId: string): Promise<WorkflowEntry | undefined> =>
      (await fixture.db().select().from(workflowEntries).where(eq(workflowEntries.id, entryId)))[0]

    it('records the resolved commit before any agent work (FR-114)', async () => {
      const { ctx } = fixture.contextFor(credential)
      const entryId = fixture.ids().a.workflowEntryId

      expect((await entryRow(entryId))?.resolvedCommit).toBeNull()

      const report = await reportEntryCheckout(ctx, {
        entryId,
        resolvedCommit: 'f'.repeat(40),
        stalenessNote: 'main was at f… when this entry was cloned.',
      })

      expect(report.recorded).toBe(true)
      expect(report.entry.resolvedCommit).toBe('f'.repeat(40))
      expect(report.entry.stalenessNote).toBe('main was at f… when this entry was cloned.')
      // Nothing about the outcome: the entry has been checked out, not finished.
      expect(report.entry.entryResult).toBeNull()
    })

    it('keeps the first commit on a retry and answers rather than raising (FR-047)', async () => {
      const { ctx } = fixture.contextFor(credential)

      const report = await reportEntryCheckout(ctx, {
        entryId: fixture.ids().a.workflowEntryId,
        resolvedCommit: '0'.repeat(40),
        stalenessNote: 'a later assessment that must not replace the first',
      })

      expect(report.recorded).toBe(false)
      expect(report.entry.resolvedCommit).toBe('f'.repeat(40))
      expect(report.entry.stalenessNote).toBe('main was at f… when this entry was cloned.')
    })

    it('refuses an entry belonging to another workflow, and records it (FR-018, SC-014)', async () => {
      const { ctx, denials } = fixture.contextFor(credential)

      await expect(
        reportEntryCheckout(ctx, {
          entryId: fixture.ids().b.workflowEntryId,
          resolvedCommit: 'c'.repeat(40),
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })

      expect(denials).toMatchObject([
        {
          reason: 'cross_workflow_write',
          workflowId: fixture.ids().a.workflowId,
          path: 'machine.reportEntryCheckout',
        },
      ])
      expect((await entryRow(fixture.ids().b.workflowEntryId))?.resolvedCommit).toBeNull()
    })

    it('reads the standings of its own run and no other (FR-018)', async () => {
      const { ctx } = fixture.contextFor(credential)
      const summary = await loadEntryStandings(ctx)

      expect(summary.entries.map(({ entryId }) => entryId)).toEqual([
        fixture.ids().a.workflowEntryId,
      ])
      // The other world's entry exists and is not in here: the read is scoped to the credential's
      // workflow, so an aggregate cannot be assembled across runs.
      expect(summary.statement).not.toContain(fixture.ids().b.repositoryUrl)
      expect(summary.pending).toBe(1)
      expect(summary.forbidsPlainSuccess).toBe(true)
    })

    it('refuses an unknown entry identically, so it is not an id oracle (FR-190)', async () => {
      const crossWorkflow = await refusalOf(() =>
        reportEntryCheckout(fixture.contextFor(credential).ctx, {
          entryId: fixture.ids().b.workflowEntryId,
          resolvedCommit: 'd'.repeat(40),
        }),
      )
      const unknown = await refusalOf(() =>
        reportEntryCheckout(fixture.contextFor(credential).ctx, {
          entryId: randomUUID(),
          resolvedCommit: 'd'.repeat(40),
        }),
      )

      expect(crossWorkflow.code).toBe(unknown.code)
      expect(crossWorkflow.message).toBe(unknown.message)
    })
  },
)
