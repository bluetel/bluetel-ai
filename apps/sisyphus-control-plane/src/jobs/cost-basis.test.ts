import { computeLeases, workflows } from '@bluetel-ai/sisyphus-api/db'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  billableMs,
  computeCost,
  COST_BASIS_JOB_NAME,
  createRateCard,
  rateCardKey,
  recordCostBasis,
  runRecordCostBasis,
  summariseComputeCost,
} from './cost-basis'
import type { WorkflowFixtures } from './workflow-fixtures'
import { createWorkflowFixtures, readTestDatabaseUrl } from './workflow-fixtures'

/**
 * **FR-041 — total run cost is attributable.**
 *
 * Two halves. The arithmetic is pure and asserted against a table of inputs, because a pricing bug
 * is silent: a figure that is wrong by a factor of sixty still looks like money. The recording is
 * asserted against the live database, because the properties that matter — idempotence, the `is
 * null` write guard, the refusal to price an unreleased lease — are all properties of the statement
 * rather than of the function.
 *
 * **Nothing here touches AWS.** It does not need a stubbed provisioner either: the facts FR-041
 * names are on `compute_leases`, and the price is injected as a rate card. If a future edit made
 * this job reach for EC2, this suite would start needing a credential, which is the signal.
 *
 * The live half is skipped — not failed — when `SISYPHUS_TEST_DATABASE_URL` is absent.
 */

const connectionString = readTestDatabaseUrl()

const HOUR_MS = 60 * 60 * 1000

/** Two prices, deliberately different, so a card that ignored purchase mode would be visible. */
const RATES = {
  'fixture.small:spot': '0.0500',
  'fixture.small:on_demand': '0.2000',
} as const

const rateCard = createRateCard(RATES)

const at = (isoDate: string): Date => new Date(isoDate)

describe('the composite rate key', () => {
  it('spells instance type and purchase mode the way the card is written', () => {
    expect(rateCardKey({ instanceType: 'fixture.small', purchaseMode: 'spot' })).toBe(
      'fixture.small:spot',
    )
  })

  it('prices the two purchase modes differently, so capacity type is part of the basis', () => {
    expect(rateCard.hourlyRate({ instanceType: 'fixture.small', purchaseMode: 'spot' })).toBe(
      '0.0500',
    )
    expect(rateCard.hourlyRate({ instanceType: 'fixture.small', purchaseMode: 'on_demand' })).toBe(
      '0.2000',
    )
  })

  it('answers undefined for an instance it has no price for', () => {
    expect(rateCard.hourlyRate({ instanceType: 'fixture.enormous', purchaseMode: 'spot' })).toBe(
      undefined,
    )
  })
})

describe('the billable lifetime', () => {
  const requestedAt = at('2026-08-05T09:00:00.000Z')
  const readyAt = at('2026-08-05T09:02:00.000Z')

  it('is measured from ready to released', () => {
    expect(
      billableMs({ requestedAt, readyAt, releasedAt: at('2026-08-05T10:02:00.000Z') }, readyAt),
    ).toBe(HOUR_MS)
  })

  it('falls back to requested when the instance never came up', () => {
    // A launch accepted and then failed still held capacity, and treating it as free would hide
    // the one class of failure that costs money.
    expect(
      billableMs(
        { requestedAt, readyAt: null, releasedAt: at('2026-08-05T09:30:00.000Z') },
        requestedAt,
      ),
    ).toBe(HOUR_MS / 2)
  })

  it('runs to the clock while the lease is still held', () => {
    expect(
      billableMs({ requestedAt, readyAt, releasedAt: null }, at('2026-08-05T09:32:00.000Z')),
    ).toBe(HOUR_MS / 2)
  })

  it('never goes negative, so a skewed clock cannot produce a credit', () => {
    expect(
      billableMs({ requestedAt, readyAt, releasedAt: at('2026-08-05T08:00:00.000Z') }, readyAt),
    ).toBe(0)
  })
})

describe('pricing a lifetime', () => {
  it.each([
    { rate: '0.0500', durationMs: HOUR_MS, expected: '0.0500' },
    { rate: '0.0500', durationMs: HOUR_MS / 2, expected: '0.0250' },
    { rate: '0.2000', durationMs: HOUR_MS * 3, expected: '0.6000' },
    { rate: '0.0500', durationMs: 0, expected: '0.0000' },
    // A minute at a spot price rounds to the column's scale rather than to a stray float tail.
    { rate: '0.0500', durationMs: 60_000, expected: '0.0008' },
  ])('$rate/hour for $durationMs ms is $expected', ({ rate, durationMs, expected }) => {
    expect(computeCost(rate, durationMs)).toBe(expected)
  })

  it('always carries the four decimal places the money column has', () => {
    expect(computeCost('1.0000', HOUR_MS)).toBe('1.0000')
  })
})

describe('summarising one lease', () => {
  const lease = {
    instanceType: 'fixture.small',
    purchaseMode: 'spot' as const,
    requestedAt: at('2026-08-05T09:00:00.000Z'),
    readyAt: at('2026-08-05T09:00:00.000Z'),
    releasedAt: at('2026-08-05T11:00:00.000Z'),
  }

  it('reports the three facts FR-041 names alongside the figure', () => {
    const basis = summariseComputeCost({ lease, rateCard, now: at('2026-08-05T12:00:00.000Z') })

    expect(basis).toStrictEqual({
      instanceType: 'fixture.small',
      purchaseMode: 'spot',
      billableMs: 2 * HOUR_MS,
      hourlyRate: '0.0500',
      cost: '0.1000',
      settled: true,
    })
  })

  it('marks a live lease unsettled, so a running figure is not mistaken for a final one', () => {
    const basis = summariseComputeCost({
      lease: { ...lease, releasedAt: null },
      rateCard,
      now: at('2026-08-05T10:00:00.000Z'),
    })

    expect(basis?.settled).toBe(false)
    expect(basis?.cost).toBe('0.0500')
  })

  it('answers undefined rather than zero for an instance the card cannot price', () => {
    expect(
      summariseComputeCost({
        lease: { ...lease, instanceType: 'fixture.enormous' },
        rateCard,
        now: at('2026-08-05T12:00:00.000Z'),
      }),
    ).toBe(undefined)
  })
})

describe.skipIf(connectionString === undefined)('recording the basis on the workflow', () => {
  let fixtures: WorkflowFixtures

  beforeAll(async () => {
    fixtures = createWorkflowFixtures(connectionString ?? '')
    await fixtures.open()
  }, 60_000)

  afterAll(async () => {
    await fixtures.close()
  }, 30_000)

  afterEach(async () => {
    await fixtures.removeAll()
  })

  /** Seed a workflow with a lease whose lifetime is `hours`, released unless told otherwise. */
  const seedLeasedWorkflow = async (options: {
    readonly label: string
    readonly hours: number
    readonly released?: boolean
    readonly instanceType?: string
    readonly purchaseMode?: 'on_demand' | 'spot'
  }): Promise<string> => {
    const workflowId = await fixtures.seedWorkflow({ label: options.label, state: 'succeeded' })
    const leaseId = await fixtures.seedLease(workflowId)

    const requestedAt = at('2026-08-05T09:00:00.000Z')

    await fixtures
      .db()
      .update(computeLeases)
      .set({
        instanceType: options.instanceType ?? 'fixture.small',
        purchaseMode: options.purchaseMode ?? 'spot',
        requestedAt,
        readyAt: requestedAt,
        releasedAt:
          options.released === false
            ? null
            : new Date(requestedAt.getTime() + options.hours * HOUR_MS),
        releaseReason: 'fixture release',
      })
      .where(eq(computeLeases.id, leaseId))

    return workflowId
  }

  const basisOf = async (workflowId: string): Promise<string | null> => {
    const rows = await fixtures
      .db()
      .select({ computeCostBasis: workflows.computeCostBasis })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
    return rows[0]?.computeCostBasis ?? null
  }

  it('writes what the instance cost, from the lease alone', async () => {
    const workflowId = await seedLeasedWorkflow({ label: 'priced', hours: 2 })

    const outcome = await recordCostBasis({ db: fixtures.db(), rateCard, workflowId })

    expect(outcome.outcome).toBe('recorded')
    // Two hours of spot at 0.05 — and the figure lands on the workflow, beside `spend_used`,
    // which is what makes the total attributable (FR-041).
    await expect(basisOf(workflowId)).resolves.toBe('0.1000')
  })

  it('prices by capacity type, not by instance class alone', async () => {
    const workflowId = await seedLeasedWorkflow({
      label: 'on-demand',
      hours: 2,
      purchaseMode: 'on_demand',
    })

    await recordCostBasis({ db: fixtures.db(), rateCard, workflowId })

    await expect(basisOf(workflowId)).resolves.toBe('0.4000')
  })

  it('is idempotent: a second run neither rewrites nor errors', async () => {
    const workflowId = await seedLeasedWorkflow({ label: 'twice', hours: 2 })

    await recordCostBasis({ db: fixtures.db(), rateCard, workflowId })
    // A changed card must not silently restate history — the recorded basis is what the platform
    // stands behind.
    const second = await recordCostBasis({
      db: fixtures.db(),
      rateCard: createRateCard({ 'fixture.small:spot': '9.0000' }),
      workflowId,
    })

    expect(second.outcome).toBe('already_recorded')
    await expect(basisOf(workflowId)).resolves.toBe('0.1000')
  })

  it('writes nothing while the lease is still held', async () => {
    const workflowId = await seedLeasedWorkflow({ label: 'live', hours: 2, released: false })

    const outcome = await recordCostBasis({
      db: fixtures.db(),
      rateCard,
      workflowId,
      now: () => at('2026-08-05T10:00:00.000Z'),
    })

    expect(outcome.outcome).toBe('not_settled')
    // But it still says what the run has cost so far, so a live figure is available without one
    // being committed.
    expect(outcome).toMatchObject({ running: { cost: '0.0500', settled: false } })
    await expect(basisOf(workflowId)).resolves.toBe(null)
  })

  it('reports a run that never held compute rather than pricing it', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'no-lease', state: 'failed' })

    await expect(
      recordCostBasis({ db: fixtures.db(), rateCard, workflowId }),
    ).resolves.toStrictEqual({ outcome: 'no_lease', workflowId })
    await expect(basisOf(workflowId)).resolves.toBe(null)
  })

  it('refuses to write zero for an instance the card cannot price', async () => {
    const workflowId = await seedLeasedWorkflow({
      label: 'unpriced',
      hours: 2,
      instanceType: 'fixture.enormous',
    })

    const outcome = await recordCostBasis({ db: fixtures.db(), rateCard, workflowId })

    expect(outcome).toMatchObject({ outcome: 'unpriced', instanceType: 'fixture.enormous' })
    // A zero here would present a configuration gap as the fact that the run was free.
    await expect(basisOf(workflowId)).resolves.toBe(null)
  })

  it('fails loudly for a workflow that does not exist', async () => {
    await expect(
      recordCostBasis({
        db: fixtures.db(),
        rateCard,
        workflowId: '00000000-0000-7000-8000-000000000000',
      }),
    ).rejects.toThrow(/does not exist/)
  })

  it('reports through the uniform job envelope', async () => {
    const workflowId = await seedLeasedWorkflow({ label: 'enveloped', hours: 1 })

    const outcome = await runRecordCostBasis({ db: fixtures.db(), rateCard, workflowId })

    expect(outcome.jobName).toBe(COST_BASIS_JOB_NAME)
    expect(outcome.ok).toBe(true)
  })
})
