import type { ComputeLease, SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { computeLeases, workflowEvents, workflows } from '@bluetel-ai/sisyphus-api/db'
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'

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
 *
 * ## A paused run costs storage and not compute (003/FR-042, SC-008)
 *
 * 002 held a paused run's instance alive, so the lease lifetime *was* the billed lifetime and this
 * module could subtract nothing. 003/FR-039 stops the instance instead, and SC-008 states the
 * consequence flatly: **"a paused workflow's compute cost is zero for the duration of the pause"**.
 * A lease lifetime that still counted those hours would report the exact number the change was made
 * to eliminate — and would report it as though nothing had changed, which is worse than reporting
 * nothing, because it would look like the pause did not work.
 *
 * So the lifetime is split. {@link ComputeCostBasis.billableMs} still means what it meant — how long
 * the lease held capacity — and {@link ComputeCostBasis.pausedMs} is how much of that the instance
 * spent stopped, with {@link ComputeCostBasis.computeMs} the difference and the only thing
 * {@link ComputeCostBasis.cost} is derived from. Keeping all three is what makes the figure
 * auditable: "we billed you for four of the six hours you held this lease, and here are the two we
 * did not" is a statement somebody can check, and "we billed you for four hours" is not.
 *
 * **Where the paused hours come from, and why not from a column.** The timeline already records
 * every `paused` and every `resumed` row, written inside `acknowledgeSupervisionCommand`'s
 * transaction and by `jobs/start-workflow.ts`'s resume. Pairing them gives the pause windows
 * exactly, for a run paused and resumed any number of times. A `workflows.paused_ms` counter would
 * be a second copy of a fact the timeline already holds, would have to be incremented by whichever
 * of several paths ended a pause, and would disagree with the timeline the first time one of them
 * did not — the same reasoning `reconcile.ts` gives for reading `paused_at` off the timeline rather
 * than adding a column for it.
 *
 * **Storage is reported for the pause and only for the pause.** FR-042 asks for a paused run's
 * storage to be *visible*, and what makes it visible is precisely that it is the cost that did not
 * go away when compute did. {@link ComputeCostBasis.pausedStorageCost} is therefore the price of
 * the retained disk over the paused hours, from a storage rate on the same injected card — not an
 * attempt to attribute storage across the run's whole life, which would need a volume size this
 * module has no business asking EC2 for.
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
  /**
   * What the run's retained disk costs per hour while its instance is stopped (003/FR-042).
   *
   * Keyed the same way, because the disk a run keeps is the one its instance class was launched
   * with — a configured pairing, not a fact this module can derive. Optional on the interface so
   * every card written before pause existed is still a card; a card without one reports the paused
   * hours and declines to price them, which is an honest gap rather than a zero.
   */
  readonly storageHourlyRate?: (key: ComputeRateKey) => string | undefined
}

/**
 * Build a rate card from a plain record keyed `"<instanceType>:<purchaseMode>"`.
 *
 * The composite key is a single string so the whole card can be carried as configuration — an
 * environment variable, a parameter-store value — without needing a nested shape.
 *
 * @param rates - Hourly rates as decimal strings, so a price is never a float in transit.
 * @param storageRates - What the retained disk costs per hour while the instance is stopped, keyed
 *   identically (003/FR-042). Omitted for a deployment that has not priced its storage yet.
 */
export const createRateCard = (
  rates: Readonly<Record<string, string>>,
  storageRates: Readonly<Record<string, string>> = {},
): ComputeRateCard => ({
  hourlyRate: (key) => rates[`${key.instanceType}:${key.purchaseMode}`],
  storageHourlyRate: (key) => storageRates[`${key.instanceType}:${key.purchaseMode}`],
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

/**
 * One stretch during which the run's instance was stopped (003/FR-039).
 *
 * `to` is `undefined` for a pause that is still in force. It is a distinct thing from a pause that
 * ended at the clock, because the second is a measurement and the first is an open interval whose
 * length depends on when you ask.
 */
export interface PauseWindow {
  readonly from: Date
  readonly to: Date | undefined
}

/** One timeline row, reduced to the two things the pause arithmetic reads. */
export interface PauseEvent {
  readonly event: 'paused' | 'resumed'
  readonly at: Date
}

/**
 * Pair `paused` and `resumed` rows into the windows the instance was stopped for.
 *
 * Tolerant of a malformed sequence in both directions, and deliberately: a second `paused` with no
 * `resumed` between them is one pause observed twice, and a `resumed` with no open pause is a
 * resume of something this lease did not see the start of. Neither is worth failing a cost
 * calculation over, and neither may open a window that swallows hours the run was working.
 *
 * @param events - Rows in ascending time order.
 * @returns Windows in the order they opened. The last may be open.
 */
export const pauseWindowsFrom = (events: readonly PauseEvent[]): readonly PauseWindow[] => {
  const windows: PauseWindow[] = []
  let openedAt: Date | undefined

  for (const event of events) {
    if (event.event === 'paused') {
      openedAt ??= event.at
      continue
    }

    if (openedAt !== undefined) {
      windows.push({ from: openedAt, to: event.at })
      openedAt = undefined
    }
  }

  if (openedAt !== undefined) {
    windows.push({ from: openedAt, to: undefined })
  }

  return windows
}

/**
 * How much of a billable window the instance spent stopped (003/FR-042, SC-008).
 *
 * Every window is clamped to the lease's own lifetime before it is counted, which is what makes the
 * two purchase modes come out right without either being special-cased. A `spot` pause releases its
 * lease at the moment it terminates the instance, so the pause that follows lies entirely after
 * `released_at` and contributes nothing — correctly, because the run was not holding capacity to be
 * refunded for. An `on_demand` pause keeps its lease live, so the same arithmetic subtracts exactly
 * the stopped hours.
 *
 * @param window - The billable lifetime: from `ready_at` (or `requested_at`), to `released_at` (or
 *   the clock).
 * @param windows - From {@link pauseWindowsFrom}.
 * @returns Never more than the window it was clamped to, and never negative.
 */
export const pausedMsWithin = (
  window: { readonly from: Date; readonly to: Date },
  windows: readonly PauseWindow[],
): number => {
  const start = window.from.getTime()
  const end = window.to.getTime()

  return windows.reduce((total, paused) => {
    const from = Math.max(start, paused.from.getTime())
    const to = Math.min(end, (paused.to ?? window.to).getTime())
    return total + Math.max(0, to - from)
  }, 0)
}

/**
 * The basis a figure was derived from — the three facts FR-041 names, the rate applied, and what
 * the pause took out of it (003/FR-042).
 */
export interface ComputeCostBasis {
  readonly instanceType: string
  readonly purchaseMode: ComputeLease['purchaseMode']
  /** How long the lease held capacity, pauses included. Unchanged in meaning since 002. */
  readonly billableMs: number
  /** How much of {@link ComputeCostBasis.billableMs} the instance spent stopped (SC-008). */
  readonly pausedMs: number
  /** The difference, and the only thing {@link ComputeCostBasis.cost} is derived from. */
  readonly computeMs: number
  readonly hourlyRate: string
  /** Compute only. Zero for the duration of every pause, which is SC-008 stated as a figure. */
  readonly cost: string
  /** `undefined` when the card has no storage price for this instance and mode. */
  readonly storageHourlyRate: string | undefined
  /**
   * What the retained disk cost over the paused hours, or `undefined` when it cannot be priced.
   *
   * Undefined rather than `'0.0000'` for the same reason {@link UnpricedCostBasis} exists: a
   * missing price is a configuration gap, and a zero would present the gap as the fact that pausing
   * is free — which is the one wrong answer nobody would go looking for.
   */
  readonly pausedStorageCost: string | undefined
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
  /**
   * When the instance was stopped, from {@link pauseWindowsFrom} (003/FR-042).
   *
   * Defaults to none, so a caller that knows the run was never paused — or one written before pause
   * existed — gets 002's answer unchanged rather than a different one.
   */
  readonly pauseWindows?: readonly PauseWindow[]
}): ComputeCostBasis | undefined => {
  const { lease, now, rateCard } = options
  const key = { instanceType: lease.instanceType, purchaseMode: lease.purchaseMode }
  const hourlyRate = rateCard.hourlyRate(key)

  if (hourlyRate === undefined) {
    return undefined
  }

  const duration = billableMs(lease, now)
  const pausedMs = pausedMsWithin(
    { from: lease.readyAt ?? lease.requestedAt, to: lease.releasedAt ?? now },
    options.pauseWindows ?? [],
  )
  // Never negative even under a clock that disagrees with itself: a pause window longer than the
  // lease it sits inside would otherwise produce a credit, and a negative cost is not a fact.
  const computeMs = Math.max(0, duration - pausedMs)
  const storageHourlyRate = rateCard.storageHourlyRate?.(key)

  return {
    instanceType: lease.instanceType,
    purchaseMode: lease.purchaseMode,
    billableMs: duration,
    pausedMs,
    computeMs,
    hourlyRate,
    // The stopped hours are not in here, and that is SC-008: a paused workflow's compute cost is
    // zero for the duration of the pause.
    cost: computeCost(hourlyRate, computeMs),
    storageHourlyRate,
    pausedStorageCost:
      storageHourlyRate === undefined ? undefined : computeCost(storageHourlyRate, pausedMs),
    settled: lease.releasedAt !== null,
  }
}

/**
 * The pause windows one run's timeline records (003/FR-042).
 *
 * Read here rather than passed in, because the caller of {@link recordCostBasis} is a scheduler
 * with a workflow id and no reason to know how a pause is recorded.
 *
 * @param db - The handle.
 * @param workflowId - The run.
 */
export const pauseWindowsFor = async (
  db: Pick<SisyphusDatabase, 'select'>,
  workflowId: string,
): Promise<readonly PauseWindow[]> => {
  const rows = await db
    .select({ event: workflowEvents.event, at: workflowEvents.createdAt })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.workflowId, workflowId),
        inArray(workflowEvents.event, ['paused', 'resumed']),
      ),
    )
    .orderBy(asc(workflowEvents.createdAt), asc(workflowEvents.id))

  return pauseWindowsFrom(
    rows.flatMap((row) =>
      row.event === 'paused' || row.event === 'resumed' ? [{ event: row.event, at: row.at }] : [],
    ),
  )
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

  const basis = summariseComputeCost({
    lease,
    rateCard,
    now,
    // FR-042. Read for every run rather than only for one currently paused: the figure being
    // written is the run's whole lifetime, and a pause it has already come back from is exactly as
    // much of that lifetime as one still in force.
    pauseWindows: await pauseWindowsFor(db, workflowId),
  })

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
