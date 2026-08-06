import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { iterations, reviewFindings } from '../../db'
import { reportIterationInput } from '../../schemas'
import type { MachineCredential } from '../context'

import {
  fourthIterationError,
  ITERATION_ORDINAL_BOUND,
  ITERATION_ORDINAL_CONSTRAINT,
  iterationHistory,
  REPORT_ITERATION_PATH,
  reportIteration,
} from './iterations'
import type { MachineFixture } from './test-support'
import { createMachineFixture, readTestDatabaseUrl, refusalOf } from './test-support'

/**
 * `reportIteration` — one pass of the autonomous loop, bounded at three **by the database**
 * (FR-061, FR-062, FR-119, FR-018, SC-014).
 *
 * The bound is the point of this suite. It is asserted three ways, because each one alone leaves
 * the hole the requirement is about:
 *
 * 1. **The DDL says so.** Read out of the migration, so a hand-edited schema that drops the
 *    constraint fails here rather than in production.
 * 2. **The database refuses a fourth row** even when the insert bypasses this resolver entirely.
 *    That is the only test that proves the bound survives a caller that is not this one.
 * 3. **The resolver turns that refusal into a `BAD_REQUEST`**, so an executor stops rather than
 *    retrying a write that can never succeed.
 */

const connectionString = readTestDatabaseUrl()

const here = dirname(fileURLToPath(import.meta.url))
const initialSchemaSql = (): string =>
  readFileSync(join(here, '..', '..', 'db', 'migrations', '0000_initial_schema.sql'), 'utf8')

describe('the three-iteration bound as declared DDL (FR-061)', () => {
  it('is a check constraint on the table, not a count in application code', () => {
    expect(initialSchemaSql()).toContain(
      `CONSTRAINT "${ITERATION_ORDINAL_CONSTRAINT}" CHECK ("iterations"."ordinal" between 1 and 3)`,
    )
  })

  it('is unique per pass, so a retry cannot become a second iteration', () => {
    expect(initialSchemaSql()).toContain('"iterations_ordinal_key" ON "iterations"')
  })

  it('names the bound and the constraint in the refusal, so the reason is not in a migration file', () => {
    const error = fourthIterationError(4)

    expect(error.code).toBe('BAD_REQUEST')
    expect(error.message).toContain(ITERATION_ORDINAL_CONSTRAINT)
    expect(error.message).toContain(String(ITERATION_ORDINAL_BOUND))
  })
})

describe('the iteration payload', () => {
  it('refuses a fourth ordinal at the edge as well as at the table', () => {
    expect(() => reportIterationInput.parse({ ordinal: 4, verdict: 'fail' })).toThrow()
  })

  it('refuses a zeroth ordinal — passes are counted from one', () => {
    expect(() => reportIterationInput.parse({ ordinal: 0, verdict: 'pass' })).toThrow()
  })

  it('defaults findings to none, so a passing pass need not send an empty array', () => {
    expect(reportIterationInput.parse({ ordinal: 1, verdict: 'pass' }).findings).toEqual([])
  })
})

describe.skipIf(connectionString === undefined)('reportIteration', () => {
  let fixture: MachineFixture
  let credential: MachineCredential
  let otherCredential: MachineCredential

  beforeAll(async () => {
    fixture = createMachineFixture(connectionString ?? '')
    await fixture.open()
    credential = await fixture.seedCredential(fixture.ids().a.workflowId)
    otherCredential = await fixture.seedCredential(fixture.ids().b.workflowId)
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  const clear = async (): Promise<void> => {
    const db = fixture.db()
    const rows = await db
      .select({ id: iterations.id })
      .from(iterations)
      .where(eq(iterations.workflowId, fixture.ids().a.workflowId))

    for (const row of rows) {
      await db.delete(reviewFindings).where(eq(reviewFindings.iterationId, row.id))
    }

    await db.delete(iterations).where(eq(iterations.workflowId, fixture.ids().a.workflowId))
  }

  beforeAll(clear, 30_000)

  it('records a failing pass with its findings anchored to entry, file and line (FR-119)', async () => {
    await clear()
    const { ctx } = fixture.contextFor(credential)

    const report = await reportIteration(ctx, {
      ordinal: 1,
      verdict: 'fail',
      findings: [
        {
          workflowEntryId: fixture.ids().a.workflowEntryId,
          filePath: 'src/checkout.ts',
          line: 42,
          severity: 'blocker',
          summary: 'The retry loop has no ceiling.',
        },
      ],
    })

    expect(report.recorded).toBe(true)
    expect(report.iteration.workflowId).toBe(fixture.ids().a.workflowId)
    expect(report.iteration.ordinal).toBe(1)
    expect(report.iteration.reviewVerdict).toBe('fail')
    expect(report.iteration.endedAt).not.toBeNull()
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.workflowEntryId).toBe(fixture.ids().a.workflowEntryId)
    expect(report.findings[0]?.filePath).toBe('src/checkout.ts')
    expect(report.findings[0]?.line).toBe(42)
  })

  it('keeps the first verdict when a retry reports the same pass again (FR-047)', async () => {
    await clear()
    const { ctx } = fixture.contextFor(credential)

    await reportIteration(ctx, {
      ordinal: 1,
      verdict: 'fail',
      findings: [{ severity: 'major', summary: 'The first report.' }],
    })

    const retry = await reportIteration(ctx, {
      ordinal: 1,
      verdict: 'pass',
      findings: [{ severity: 'info', summary: 'A different story.' }],
    })

    expect(retry.recorded).toBe(false)
    expect(retry.iteration.reviewVerdict).toBe('fail')
    expect(retry.findings).toHaveLength(1)
    expect(retry.findings[0]?.summary).toBe('The first report.')
  })

  it('refuses a fourth pass at the database, however the row is offered', async () => {
    await clear()
    const { ctx } = fixture.contextFor(credential)

    for (const ordinal of [1, 2, 3]) {
      await reportIteration(ctx, { ordinal, verdict: 'fail', findings: [] })
    }

    // Straight at the table, bypassing this resolver and the input schema entirely. This is the
    // assertion that matters: the bound holds for writers that never came through here.
    await expect(
      fixture
        .db()
        .insert(iterations)
        .values({ workflowId: fixture.ids().a.workflowId, ordinal: 4, reviewVerdict: 'fail' }),
    ).rejects.toThrow()
  })

  it('turns the constraint violation into a refusal the executor will not retry', async () => {
    await clear()
    const { ctx } = fixture.contextFor(credential)

    const refusal = await refusalOf(async () =>
      reportIteration(ctx, { ordinal: 4, verdict: 'fail', findings: [] }),
    )

    expect(refusal.code).toBe('BAD_REQUEST')
    expect(refusal.message).toContain(ITERATION_ORDINAL_CONSTRAINT)
  })

  it('keeps the whole history so an exhausted run can surface what was never fixed (FR-062)', async () => {
    await clear()
    const { ctx } = fixture.contextFor(credential)

    await reportIteration(ctx, {
      ordinal: 1,
      verdict: 'fail',
      findings: [{ severity: 'blocker', summary: 'Raised first and never fixed.' }],
    })
    await reportIteration(ctx, {
      ordinal: 2,
      verdict: 'fail',
      findings: [{ severity: 'major', summary: 'Raised second.' }],
    })
    await reportIteration(ctx, {
      ordinal: 3,
      verdict: 'fail',
      findings: [{ severity: 'minor', summary: 'Raised third.' }],
    })

    const history = await iterationHistory(ctx)

    expect(history.map((pass) => pass.iteration.ordinal)).toEqual([1, 2, 3])
    expect(history.flatMap((pass) => pass.findings.map((finding) => finding.summary))).toEqual([
      'Raised first and never fixed.',
      'Raised second.',
      'Raised third.',
    ])
  })

  it('refuses and records a finding anchored to another workflow entry (FR-018, SC-014)', async () => {
    await clear()
    const { ctx, denials } = fixture.contextFor(credential)

    const refusal = await refusalOf(async () =>
      reportIteration(ctx, {
        ordinal: 1,
        verdict: 'fail',
        findings: [
          {
            workflowEntryId: fixture.ids().b.workflowEntryId,
            severity: 'blocker',
            summary: 'Anchored at somebody else’s repository.',
          },
        ],
      }),
    )

    expect(refusal.code).toBe('FORBIDDEN')
    expect(denials).toHaveLength(1)
    expect(denials[0]?.path).toBe(REPORT_ITERATION_PATH)
    expect(denials[0]?.reason).toBe('cross_workflow_write')
  })

  it('records nothing at all when one anchor of a batch is out of scope', async () => {
    await clear()
    const { ctx } = fixture.contextFor(credential)

    await refusalOf(async () =>
      reportIteration(ctx, {
        ordinal: 1,
        verdict: 'fail',
        findings: [
          { severity: 'minor', summary: 'A legitimate finding.' },
          {
            workflowEntryId: fixture.ids().b.workflowEntryId,
            severity: 'blocker',
            summary: 'And one that is not.',
          },
        ],
      }),
    )

    expect(await iterationHistory(ctx)).toEqual([])
  })

  it('scopes every write to the credential — two runs keep separate histories', async () => {
    await clear()
    const mine = fixture.contextFor(credential)
    const theirs = fixture.contextFor(otherCredential)

    await reportIteration(mine.ctx, { ordinal: 1, verdict: 'fail', findings: [] })
    await reportIteration(theirs.ctx, { ordinal: 1, verdict: 'pass', findings: [] })

    const history = await iterationHistory(mine.ctx)

    expect(history).toHaveLength(1)
    expect(history[0]?.iteration.workflowId).toBe(fixture.ids().a.workflowId)
    expect(history[0]?.iteration.reviewVerdict).toBe('fail')

    await fixture
      .db()
      .delete(iterations)
      .where(eq(iterations.workflowId, fixture.ids().b.workflowId))
  })
})
