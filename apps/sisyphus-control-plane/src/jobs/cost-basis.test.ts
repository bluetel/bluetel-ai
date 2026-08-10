import { computeLeases, workflowEvents, workflows } from '@bluetel-ai/sisyphus-api/db'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  billableMs,
  computeCost,
  COST_BASIS_JOB_NAME,
  createRateCard,
  pausedMsWithin,
  pauseWindowsFrom,
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

/**
 * Storage priced at a twentieth of compute, and deliberately not a round fraction of it.
 *
 * FR-042's whole point is that the two are different numbers, so a test in which they happened to
 * coincide would pass against an implementation that charged compute for the paused hours.
 */
const STORAGE_RATES = {
  'fixture.small:spot': '0.0025',
  'fixture.small:on_demand': '0.0100',
} as const

const rateCard = createRateCard(RATES, STORAGE_RATES)

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

/**
 * **The pause windows, from a timeline that is not guaranteed to be tidy (003/FR-042).**
 *
 * There is no `paused_ms` column and there should not be one: the timeline already records every
 * `paused` and `resumed` row. What the timeline does not promise is that they alternate — a pause
 * observed twice, or a resume of something this process did not see the start of, are both things
 * that happen — so the pairing has to be total over any sequence, and neither case may open a
 * window that swallows hours the run spent working.
 */
describe('pairing pauses with resumes', () => {
  const at2 = (hour: number): Date => at(`2026-08-05T${String(hour).padStart(2, '0')}:00:00.000Z`)

  it('pairs each pause with the resume that follows it', () => {
    expect(
      pauseWindowsFrom([
        { event: 'paused', at: at2(9) },
        { event: 'resumed', at: at2(10) },
        { event: 'paused', at: at2(12) },
        { event: 'resumed', at: at2(13) },
      ]),
    ).toStrictEqual([
      { from: at2(9), to: at2(10) },
      { from: at2(12), to: at2(13) },
    ])
  })

  it('leaves the last window open when the run is still paused', () => {
    expect(pauseWindowsFrom([{ event: 'paused', at: at2(9) }])).toStrictEqual([
      { from: at2(9), to: undefined },
    ])
  })

  it('treats a repeated pause as one pause, not two overlapping ones', () => {
    // Overlapping windows would double-count the same hours and could subtract more than the
    // lease's whole lifetime.
    expect(
      pauseWindowsFrom([
        { event: 'paused', at: at2(9) },
        { event: 'paused', at: at2(10) },
        { event: 'resumed', at: at2(11) },
      ]),
    ).toStrictEqual([{ from: at2(9), to: at2(11) }])
  })

  it('ignores a resume with no pause open before it', () => {
    expect(pauseWindowsFrom([{ event: 'resumed', at: at2(9) }])).toStrictEqual([])
  })
})

describe('how much of a billable window was paused', () => {
  const window = {
    from: at('2026-08-05T09:00:00.000Z'),
    to: at('2026-08-05T13:00:00.000Z'),
  }

  it('counts a window that sits inside the lease', () => {
    expect(
      pausedMsWithin(window, [
        { from: at('2026-08-05T10:00:00.000Z'), to: at('2026-08-05T11:00:00.000Z') },
      ]),
    ).toBe(HOUR_MS)
  })

  it('clamps a window that overruns the lease at both ends', () => {
    expect(
      pausedMsWithin(window, [
        { from: at('2026-08-05T08:00:00.000Z'), to: at('2026-08-05T14:00:00.000Z') },
      ]),
    ).toBe(4 * HOUR_MS)
  })

  it('counts an open window up to the end of the lease and no further', () => {
    expect(pausedMsWithin(window, [{ from: at('2026-08-05T12:00:00.000Z'), to: undefined }])).toBe(
      HOUR_MS,
    )
  })

  it('counts nothing for a window entirely outside the lease — the spot shape', () => {
    expect(
      pausedMsWithin(window, [
        { from: at('2026-08-05T14:00:00.000Z'), to: at('2026-08-05T15:00:00.000Z') },
      ]),
    ).toBe(0)
  })

  it('adds up several pauses of one run', () => {
    expect(
      pausedMsWithin(window, [
        { from: at('2026-08-05T09:30:00.000Z'), to: at('2026-08-05T10:00:00.000Z') },
        { from: at('2026-08-05T11:00:00.000Z'), to: at('2026-08-05T12:00:00.000Z') },
      ]),
    ).toBe(HOUR_MS * 1.5)
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
      // A run that was never paused: the lifetime is all compute, and the storage figure is the
      // zero it genuinely is rather than an absence.
      pausedMs: 0,
      computeMs: 2 * HOUR_MS,
      hourlyRate: '0.0500',
      cost: '0.1000',
      storageHourlyRate: '0.0025',
      pausedStorageCost: '0.0000',
      settled: true,
    })
  })

  /**
   * **SC-008 as a figure: a paused workflow's compute cost is zero for the duration of the pause.**
   *
   * The lease is held for four hours and the instance is stopped for two of them, so the assertion
   * that carries the requirement is that the cost is the two-hour figure and not the four-hour one.
   * `billableMs` deliberately still reports four: "we billed you for two of the four hours you held
   * this lease" is a statement somebody can check, and "we billed you for two hours" is not.
   */
  it('bills compute for the hours the instance was running and storage for the rest (FR-042)', () => {
    const basis = summariseComputeCost({
      lease: {
        ...lease,
        purchaseMode: 'on_demand',
        releasedAt: at('2026-08-05T13:00:00.000Z'),
      },
      rateCard,
      now: at('2026-08-05T14:00:00.000Z'),
      pauseWindows: [{ from: at('2026-08-05T10:00:00.000Z'), to: at('2026-08-05T12:00:00.000Z') }],
    })

    expect(basis).toMatchObject({
      billableMs: 4 * HOUR_MS,
      pausedMs: 2 * HOUR_MS,
      computeMs: 2 * HOUR_MS,
      // Two hours of on-demand at 0.20, not four. Four would be 0.8000 — the exact number FR-039
      // was implemented to stop producing.
      cost: '0.4000',
      // And what the pause did cost: two hours of retained disk.
      pausedStorageCost: '0.0200',
    })
  })

  it('declines to price the paused hours rather than calling them free', () => {
    const basis = summariseComputeCost({
      lease,
      rateCard: createRateCard(RATES),
      now: at('2026-08-05T12:00:00.000Z'),
      pauseWindows: [{ from: at('2026-08-05T09:30:00.000Z'), to: at('2026-08-05T10:00:00.000Z') }],
    })

    // The hours are still reported; only the price is missing, and a zero here would present a
    // configuration gap as the fact that pausing costs nothing.
    expect(basis).toMatchObject({
      pausedMs: HOUR_MS / 2,
      storageHourlyRate: undefined,
      pausedStorageCost: undefined,
    })
  })

  it('subtracts nothing for a pause that began after the lease was released', () => {
    // The `spot` shape: the pause terminated the instance and released the lease in the same
    // breath, so the pause window lies outside the billable lifetime entirely. Nothing here
    // special-cases the purchase mode — the clamping does it.
    const basis = summariseComputeCost({
      lease,
      rateCard,
      now: at('2026-08-05T14:00:00.000Z'),
      pauseWindows: [{ from: at('2026-08-05T11:00:00.000Z'), to: undefined }],
    })

    expect(basis).toMatchObject({ billableMs: 2 * HOUR_MS, pausedMs: 0, cost: '0.1000' })
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

  /**
   * **FR-042 and SC-008, end to end and off the timeline.**
   *
   * Nothing is passed in: the pause windows are read from the `paused` and `resumed` rows the
   * platform already writes, which is what makes this work for a run paused and resumed several
   * times without anybody maintaining a counter.
   */
  describe('a paused run costs storage and not compute (FR-042, SC-008)', () => {
    /** Write the timeline rows a pause and a resume leave, at chosen instants. */
    const recordPause = async (
      workflowId: string,
      windows: readonly { readonly from: string; readonly to?: string }[],
    ): Promise<void> => {
      for (const window of windows) {
        await fixtures
          .db()
          .insert(workflowEvents)
          .values({
            workflowId,
            event: 'paused',
            actorType: 'executor',
            createdAt: at(window.from),
            detail: { pausePath: 'stopped' },
          })

        if (window.to !== undefined) {
          await fixtures
            .db()
            .insert(workflowEvents)
            .values({
              workflowId,
              event: 'resumed',
              actorType: 'control_plane',
              createdAt: at(window.to),
            })
        }
      }
    }

    it('writes the compute figure with the paused hours taken out', async () => {
      const workflowId = await seedLeasedWorkflow({
        label: 'paused-od',
        hours: 4,
        purchaseMode: 'on_demand',
      })
      await recordPause(workflowId, [
        { from: '2026-08-05T10:00:00.000Z', to: '2026-08-05T12:00:00.000Z' },
      ])

      const outcome = await recordCostBasis({ db: fixtures.db(), rateCard, workflowId })

      expect(outcome).toMatchObject({
        outcome: 'recorded',
        basis: { billableMs: 4 * HOUR_MS, pausedMs: 2 * HOUR_MS, pausedStorageCost: '0.0200' },
      })
      // Two hours of on-demand at 0.20. Held for four; billed for two.
      await expect(basisOf(workflowId)).resolves.toBe('0.4000')
    })

    it('takes out every pause, for a run paused more than once', async () => {
      const workflowId = await seedLeasedWorkflow({
        label: 'paused-twice',
        hours: 4,
        purchaseMode: 'on_demand',
      })
      await recordPause(workflowId, [
        { from: '2026-08-05T09:30:00.000Z', to: '2026-08-05T10:00:00.000Z' },
        { from: '2026-08-05T11:00:00.000Z', to: '2026-08-05T12:00:00.000Z' },
      ])

      await recordCostBasis({ db: fixtures.db(), rateCard, workflowId })

      // Two and a half of the four hours ran: 2.5 × 0.20.
      await expect(basisOf(workflowId)).resolves.toBe('0.5000')
    })

    it('bills a spot run for its whole lease, because its pause released it', async () => {
      // The pause terminated the instance and released the lease at the same instant, so there are
      // no stopped hours inside the lease to subtract. No branch here says so — the clamping does.
      const workflowId = await seedLeasedWorkflow({ label: 'paused-spot', hours: 2 })
      await recordPause(workflowId, [{ from: '2026-08-05T11:00:00.000Z' }])

      await recordCostBasis({ db: fixtures.db(), rateCard, workflowId })

      await expect(basisOf(workflowId)).resolves.toBe('0.1000')
    })

    it('bills nothing at all for a run that has been paused since it became usable', async () => {
      const workflowId = await seedLeasedWorkflow({
        label: 'paused-throughout',
        hours: 2,
        purchaseMode: 'on_demand',
      })
      await recordPause(workflowId, [{ from: '2026-08-05T09:00:00.000Z' }])

      const outcome = await recordCostBasis({ db: fixtures.db(), rateCard, workflowId })

      // SC-008 at its limit: compute cost is zero for the duration of the pause, and here the
      // pause is the whole duration. The storage the run went on paying for is reported beside it,
      // which is the half of FR-042 that says the cost must be *visible*.
      expect(outcome).toMatchObject({ basis: { computeMs: 0, pausedStorageCost: '0.0200' } })
      await expect(basisOf(workflowId)).resolves.toBe('0.0000')
    })
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
