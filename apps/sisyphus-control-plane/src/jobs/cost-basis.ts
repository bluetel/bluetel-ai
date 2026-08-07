import type { ComputeLease, SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { computeLeases, workflows } from '@bluetel-ai/sisyphus-api/db'
import { and, desc, eq, isNull } from 'drizzle-orm'

import type { JobOutcome } from './run-job'
import { runJob } from './run-job'

/**
 * **Compute cost basis (T133, FR-041) — what the instance actually cost.**
 *
 * ## Why this is a separate job rather than a line in teardown
 *
 * FR-041 asks for the compute cost basis to be recorded "alongside model consumption figures, so
 * total run cost is attributable". Model consumption arrives continuously from the executor
 * (`heartbeat`, `reportTerminal` → `workflows.spend_used`). Compute cost cannot: it is not knowable
 * until the lease is **released**, because until then the lifetime is still growing. So the two
 * halves of a run's cost are written at different moments by different actors, and the compute half
 * needs a step of its own that runs after the release.
 *
 * It is deliberately not folded into `teardown-workflow.ts`. Teardown's ordering — confirm
 * durability, then destroy, then revoke — is a safety property (SC-007), and a pricing arithmetic
 * error inside it would fail a teardown that had already terminated an instance. Attribution is
 * worth getting right; it is not worth holding a paid instance for. This job is therefore
 * idempotent and re-runnable: it can be invoked after teardown, after the reconciler released a
 * lease, or as a sweep over runs whose basis is still null, and any of those converge on the same
 * answer.
 *
 * ## It never reaches AWS
 *
 * The facts FR-041 names — instance class, capacity type, lifetime — are already recorded, on
 * `compute_leases`: the provisioning job wrote `instance_type` and `purchase_mode` when it took the
 * lease, and `requested_at` / `ready_at` / `released_at` bound the lifetime. There is nothing to ask
 * EC2. Nor is there a price to ask it for: the {@link ComputeRateCard} is **injected**, so this
 * module makes no network call of any kind and a test needs no account, no region and no
 * credential — the same rule `aws/compute.ts` follows for the provisioner itself.
 *
 * That the rate card is configuration rather than a lookup is also honest about what a cost *basis*
 * is. It is the platform's stated basis for attributing a bill, not a reconciliation against an
 * invoice that arrives weeks later. Recording the basis alongside the lifetime it was applied to is
 * what makes the figure auditable when the invoice does arrive.
 *
 * ## The lifetime that is billed
 *
 * From `ready_at` when the instance became usable, falling back to `requested_at` when it never
 * did. The fallback is not a rounding convenience: a launch that was accepted and then failed to
 * come up **was** billed for the capacity it held, and treating that as free would make the one
 * category of failure that costs money invisible in the attribution. The end is `released_at`, or
 * the clock for a lease that is still live — which is why {@link summariseComputeCost} is exposed
 * separately from the write: the panel can show a running figure for a live run without this job
 * committing one.
 */

export const COST_BASIS_JOB_NAME = 'record-cost-basis'

/** Milliseconds in a billable hour, named so the conversion is not a magic number in a division. */
const MS_PER_HOUR = 60 * 60 * 1000

/** Money is `numeric(12,4)`, so every figure this module produces carries four decimal places. */
const MONEY_SCALE = 4

/** What a lease costs per hour, keyed by the two facts that determine it (FR-041). */
export interface ComputeRateKey {
  readonly instanceType: string
  readonly purchaseMode: ComputeLease['purchaseMode']
}

/**
 * The price seam.
 *
 * An interface rather than a table, because the price of an instance-hour is deployment
 * configuration — it varies by region, by agreement and over time — and a table compiled into the
 * control plane would be a price list nobody could correct without a release. Returning `undefined`
 * for an unknown combination is a supported answer: see {@link UnpricedCostBasis}.
 */
export interface ComputeRateCard {
  readonly hourlyRate: (key: ComputeRateKey) => string | undefined
}

/**
 * Build a rate card from a plain record keyed `"<instanceType>:<purchaseMode>"`.
 *
 * The composite key is a single string so the whole card can be carried as configuration — an
 * environment variable, a parameter-store value — without needing a nested shape.
 *
 * @param rates - Hourly rates as decimal strings, so a price is never a float in transit.
 */
export const createRateCard = (rates: Readonly<Record<string, string>>): ComputeRateCard => ({
  hourlyRate: (key) => rates[`${key.instanceType}:${key.purchaseMode}`],
})

/** How the composite key is spelled, exposed so a caller building a card cannot guess wrong. */
export const rateCardKey = (key: ComputeRateKey): string =>
  `${key.instanceType}:${key.purchaseMode}`

/**
 * How long a lease held capacity, in milliseconds.
 *
 * @param lease - Its three timestamps. `readyAt` is preferred and `requestedAt` is the fallback;
 *   see the module comment for why a launch that never came up is still billable.
 * @param now - The clock, for a lease that has not been released.
 * @returns Never negative: a clock skew that put `released_at` before `ready_at` would otherwise
 *   produce a credit, and a negative cost is not a fact about anything.
 */
export const billableMs = (
  lease: Pick<ComputeLease, 'readyAt' | 'releasedAt' | 'requestedAt'>,
  now: Date,
): number => {
  const from = (lease.readyAt ?? lease.requestedAt).getTime()
  const to = (lease.releasedAt ?? now).getTime()
  return Math.max(0, to - from)
}

/**
 * Money from a rate and a duration.
 *
 * Rounded half-up to the column's four decimal places at the **end** rather than at each step, so
 * the recorded figure is the rounded true product rather than a product of already-rounded parts.
 *
 * @param hourlyRate - A decimal string from the rate card.
 * @param durationMs - From {@link billableMs}.
 */
export const computeCost = (hourlyRate: string, durationMs: number): string => {
  const exact = (Number(hourlyRate) * durationMs) / MS_PER_HOUR
  return (Math.round(exact * 10 ** MONEY_SCALE) / 10 ** MONEY_SCALE).toFixed(MONEY_SCALE)
}

/** The basis a figure was derived from — the three facts FR-041 names, plus the rate applied. */
export interface ComputeCostBasis {
  readonly instanceType: string
  readonly purchaseMode: ComputeLease['purchaseMode']
  readonly billableMs: number
  readonly hourlyRate: string
  readonly cost: string
  /** False while the lease is still held: the figure is a running one, not a final one. */
  readonly settled: boolean
}

/**
 * Price one lease without writing anything.
 *
 * Exposed separately because a live run has a cost too, and a panel that wants to show it must not
 * have to commit a figure that is still growing.
 *
 * @returns `undefined` when the rate card has no entry for this instance and purchase mode.
 */
export const summariseComputeCost = (options: {
  readonly lease: Pick<
    ComputeLease,
    'instanceType' | 'purchaseMode' | 'readyAt' | 'releasedAt' | 'requestedAt'
  >
  readonly rateCard: ComputeRateCard
  readonly now: Date
}): ComputeCostBasis | undefined => {
  const { lease, now, rateCard } = options
  const hourlyRate = rateCard.hourlyRate({
    instanceType: lease.instanceType,
    purchaseMode: lease.purchaseMode,
  })

  if (hourlyRate === undefined) {
    return undefined
  }

  const duration = billableMs(lease, now)

  return {
    instanceType: lease.instanceType,
    purchaseMode: lease.purchaseMode,
    billableMs: duration,
    hourlyRate,
    cost: computeCost(hourlyRate, duration),
    settled: lease.releasedAt !== null,
  }
}

/** The basis was priced and written to the workflow. */
export interface RecordedCostBasis {
  readonly outcome: 'recorded'
  readonly workflowId: string
  readonly basis: ComputeCostBasis
}

/**
 * A figure is already on the workflow.
 *
 * Not an error, and not overwritten. The recorded basis is what the platform stands behind; a
 * second run of this job against a changed rate card must not silently restate history.
 */
export interface AlreadyRecordedCostBasis {
  readonly outcome: 'already_recorded'
  readonly workflowId: string
  readonly computeCostBasis: string
}

/** The lease is still held, so the lifetime is still growing and there is no final figure yet. */
export interface UnsettledCostBasis {
  readonly outcome: 'not_settled'
  readonly workflowId: string
  /** The running figure, so a caller can still show something. Never written. */
  readonly running: ComputeCostBasis | undefined
}

/** No lease was ever taken — a run that failed admission holds no compute and cost nothing. */
export interface NoLeaseCostBasis {
  readonly outcome: 'no_lease'
  readonly workflowId: string
}

/**
 * The rate card has no entry for this instance and purchase mode.
 *
 * Reported rather than defaulted to zero. A missing price is a gap in the platform's configuration,
 * and a zero written into `compute_cost_basis` would present that gap as the fact that the run was
 * free — which is the one wrong answer that nobody would go looking for.
 */
export interface UnpricedCostBasis {
  readonly outcome: 'unpriced'
  readonly workflowId: string
  readonly instanceType: string
  readonly purchaseMode: ComputeLease['purchaseMode']
}

export type CostBasisOutcome =
  | AlreadyRecordedCostBasis
  | NoLeaseCostBasis
  | RecordedCostBasis
  | UnpricedCostBasis
  | UnsettledCostBasis

export interface RecordCostBasisOptions {
  readonly db: SisyphusDatabase
  readonly rateCard: ComputeRateCard
  readonly workflowId: string
  /** Injectable clock, so a running figure is a function of an argument rather than of `Date.now()`. */
  readonly now?: () => Date
}

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * Record what one run's compute actually cost (FR-041).
 *
 * Reads the released lease, prices it against the injected card, and writes the figure to
 * `workflows.compute_cost_basis` — guarded by `is null` in the `where`, so two concurrent
 * invocations write once between them rather than racing to overwrite.
 *
 * @param options - The handle, the rate card, and the run.
 * @returns Which of the five things happened. Only `recorded` wrote anything.
 */
export const recordCostBasis = async (
  options: RecordCostBasisOptions,
): Promise<CostBasisOutcome> => {
  const { db, rateCard, workflowId } = options
  const now = (options.now ?? ((): Date => new Date()))()

  const workflow = firstRow(
    await db
      .select({ computeCostBasis: workflows.computeCostBasis })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1),
  )

  if (workflow === undefined) {
    throw new Error(
      `Workflow ${workflowId} does not exist, so there is no run to attribute compute cost to.`,
    )
  }

  if (workflow.computeCostBasis !== null) {
    return { outcome: 'already_recorded', workflowId, computeCostBasis: workflow.computeCostBasis }
  }

  // Newest lease last: FR-078's partial unique index allows at most one *live* lease per workflow,
  // but a resumed run may have held one before, and the one that matters is the one that was
  // released most recently.
  const lease = firstRow(
    await db
      .select({
        instanceType: computeLeases.instanceType,
        purchaseMode: computeLeases.purchaseMode,
        requestedAt: computeLeases.requestedAt,
        readyAt: computeLeases.readyAt,
        releasedAt: computeLeases.releasedAt,
      })
      .from(computeLeases)
      .where(eq(computeLeases.workflowId, workflowId))
      .orderBy(desc(computeLeases.id))
      .limit(1),
  )

  if (lease === undefined) {
    return { outcome: 'no_lease', workflowId }
  }

  const basis = summariseComputeCost({ lease, rateCard, now })

  if (lease.releasedAt === null) {
    return { outcome: 'not_settled', workflowId, running: basis }
  }

  if (basis === undefined) {
    return {
      outcome: 'unpriced',
      workflowId,
      instanceType: lease.instanceType,
      purchaseMode: lease.purchaseMode,
    }
  }

  await db
    .update(workflows)
    .set({ computeCostBasis: basis.cost })
    // `is null` in the predicate rather than in application code above it: two invocations racing
    // — a teardown-triggered one and a sweep — must write once between them, and the guard that
    // decides which is the database's rather than a check-then-act in this process.
    .where(and(eq(workflows.id, workflowId), isNull(workflows.computeCostBasis)))

  return { outcome: 'recorded', workflowId, basis }
}

/** Cost-basis recording wrapped in the uniform job envelope. */
export const runRecordCostBasis = (
  options: RecordCostBasisOptions,
): Promise<JobOutcome<CostBasisOutcome>> =>
  runJob(COST_BASIS_JOB_NAME, () => recordCostBasis(options))
