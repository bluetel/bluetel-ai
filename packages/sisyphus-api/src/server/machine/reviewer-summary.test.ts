import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { workflows } from '../../db'
import type { MachineCredential } from '../context'

import { reportReviewerSummary } from './reviewer-summary'
import type { MachineFixture } from './test-support'
import { createMachineFixture, readTestDatabaseUrl } from './test-support'

/**
 * `reportReviewerSummary` — the summary lands on the credential's workflow and on no other
 * (FR-153, FR-018).
 *
 * The cross-workflow property is asserted differently here than on `registerArtifact`, and that is
 * the point: this payload carries no id, so there is nothing to pass an out-of-scope value in. The
 * test therefore proves the *consequence* — a credential for A leaves B's column untouched — rather
 * than asserting a refusal that has no way to fire.
 */

const connectionString = readTestDatabaseUrl()

describe.skipIf(connectionString === undefined)('reportReviewerSummary', () => {
  let fixture: MachineFixture
  let credential: MachineCredential

  const readSummary = async (workflowId: string): Promise<string | null> => {
    const rows = await fixture
      .db()
      .select({ summary: workflows.reviewerSummary })
      .from(workflows)
      .where(eq(workflows.id, workflowId))

    return rows[0]?.summary ?? null
  }

  beforeAll(async () => {
    fixture = createMachineFixture(connectionString ?? '')
    await fixture.open()
    credential = await fixture.seedCredential(fixture.ids().a.workflowId)
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  it('records the summary against the credential’s workflow', async () => {
    const { ctx } = fixture.contextFor(credential)

    const report = await reportReviewerSummary(ctx, {
      summary: 'Two files changed; no migrations.',
    })

    expect(report.workflowId).toBe(fixture.ids().a.workflowId)
    expect(report.recorded).toBe(true)
    expect(report.replaced).toBe(false)
    await expect(readSummary(fixture.ids().a.workflowId)).resolves.toBe(
      'Two files changed; no migrations.',
    )
  })

  it('is idempotent — the identical summary again writes nothing (FR-047)', async () => {
    const { ctx } = fixture.contextFor(credential)

    const report = await reportReviewerSummary(ctx, {
      summary: 'Two files changed; no migrations.',
    })

    expect(report.recorded).toBe(false)
    expect(report.replaced).toBe(false)
  })

  it('replaces a refined summary and says that it did', async () => {
    const { ctx } = fixture.contextFor(credential)

    const report = await reportReviewerSummary(ctx, {
      summary: 'Two files changed; no migrations. Regenerate the client before reviewing.',
    })

    expect(report.recorded).toBe(true)
    expect(report.replaced).toBe(true)
    await expect(readSummary(fixture.ids().a.workflowId)).resolves.toContain(
      'Regenerate the client',
    )
  })

  it('leaves the other workflow’s summary untouched — the payload names no workflow', async () => {
    await expect(readSummary(fixture.ids().b.workflowId)).resolves.toBeNull()
  })

  it('records a summary reported after the run reached a terminal state', async () => {
    const { ctx } = fixture.contextFor(credential)

    await fixture
      .db()
      .update(workflows)
      .set({ state: 'succeeded', terminalOutcome: 'succeeded' })
      .where(eq(workflows.id, fixture.ids().a.workflowId))

    // A retry landing after `reportTerminal` is ordinary. Refusing it would trap the executor in a
    // retry loop and lose the one artefact FR-153 exists for.
    const report = await reportReviewerSummary(ctx, { summary: 'Landed as PR #9.' })

    expect(report.recorded).toBe(true)
  })
})
