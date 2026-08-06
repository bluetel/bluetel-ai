/**
 * Local cap enforcement (T061, FR-055, FR-093).
 *
 * This is the only local brake on an unattended run. The agent's own
 * `--max-turns` is a second line, not the first: it is a limit the agent
 * applies to itself, and it says nothing at all about spend. Without this
 * module a badly specified autonomous ticket has nothing between it and a
 * surprise bill.
 *
 * Three things it will not do, each for a reason:
 *
 * - **It will not stop mid-turn.** A turn in flight has produced work that is
 *   not yet in the conversation or on disk; killing it loses that work for
 *   nothing, since the cost has already been incurred. `observe` therefore
 *   only arms a stop, and `checkBoundary` — called at a completed turn — is
 *   the only thing that returns one. The caller then runs the ordinary suspend
 *   path, so the workspace and conversation are snapshotted before release.
 * - **It will not silently ignore a cap the operator set.** Where the setup
 *   bundle declares that its credential does not meter spend (FR-093), the
 *   spend cap is advisory, and it is reported as advisory from the moment the
 *   enforcer is built — not discovered by nothing happening when it is
 *   exceeded. Silently ignoring a cap someone set is the worst behaviour
 *   available here.
 * - **It will not stop enforcing the turn cap because spend is unmeasurable.**
 *   Turns are always countable, so the turn cap is always enforced.
 */

import type { AgentUsage } from '../agent'

export type CapKind = 'turn' | 'spend'

export interface CapLimits {
  /** Maximum assistant turns. Enforced whatever the bundle declares. */
  readonly turnCap?: number
  /** Maximum spend in USD. Advisory where the bundle cannot meter spend. */
  readonly spendCapUsd?: number
  /**
   * The bundle's `spend_caps_enforceable` declaration (FR-093). A flat-rate
   * seat credential cannot meter per-workflow spend, so a cap set against it
   * is a statement of intent rather than a limit.
   */
  readonly spendCapsEnforceable: boolean
}

export interface CapBreach {
  readonly cap: CapKind
  readonly limit: number
  readonly used: number
  /** True when this cap cannot be enforced and is reported instead. */
  readonly advisory: boolean
}

export interface CapEvaluation {
  /** Every cap reached, in the order they are checked. */
  readonly breaches: readonly CapBreach[]
  /** The breach that requires stopping, if any. */
  readonly enforced?: CapBreach
  /** Breaches that are reported rather than acted on (FR-093). */
  readonly advisory: readonly CapBreach[]
}

export interface CapConsumptionReport {
  readonly outcome: 'capped'
  readonly reason: string
  readonly turnsUsed: number
  /** Decimal string, matching what the machine surface accepts. */
  readonly spendUsed: string
}

export interface CapStopDecision {
  readonly action: 'stop'
  /** Every cap reached by the time the boundary was reached. */
  readonly breaches: readonly CapBreach[]
  readonly consumption: AgentUsage
  /**
   * Always true. The stop happens at a turn boundary and the caller is
   * expected to snapshot before releasing compute (FR-055, FR-050).
   */
  readonly preserveWorkInProgress: true
  /** Ready to hand to `reportTerminal`. */
  readonly report: CapConsumptionReport
}

export interface CapContinueDecision {
  readonly action: 'continue'
  /** Caps exceeded but not enforceable. Surfaced, not acted on (FR-093). */
  readonly advisory: readonly CapBreach[]
}

export type CapDecision = CapStopDecision | CapContinueDecision

export interface CapEnforcer {
  /**
   * Record consumption seen part-way through a turn. Never stops; it only
   * arms the stop that the next boundary will act on.
   */
  readonly observe: (usage: AgentUsage) => CapEvaluation
  /** Called at a completed turn — the only safe place to stop. */
  readonly checkBoundary: (usage: AgentUsage) => CapDecision
  /** True once a cap has been reached and a stop is waiting for a boundary. */
  readonly isStopArmed: boolean
  /**
   * Statements about caps that are set but not enforceable, available before
   * the run starts so the panel can show the limitation rather than implying
   * a cap is in force (FR-093).
   */
  readonly advisoryNotices: readonly string[]
}

const SPEND_DECIMAL_PLACES = 4

const isUsableLimit = (limit: number | undefined): limit is number =>
  limit !== undefined && Number.isFinite(limit) && limit >= 0

export const formatSpend = (amount: number): string =>
  (Number.isFinite(amount) ? Math.max(amount, 0) : 0).toFixed(SPEND_DECIMAL_PLACES)

/**
 * Human wording for a cap that is set but cannot be enforced. Named separately
 * because it is shown at run start, long before any figure could exceed it.
 */
export const capAdvisoryNotices = (limits: CapLimits): readonly string[] => {
  if (limits.spendCapsEnforceable || !isUsableLimit(limits.spendCapUsd)) {
    return []
  }

  return [
    `Spend cap of $${formatSpend(limits.spendCapUsd)} is advisory: the setup bundle declares ` +
      'that the credential it installs does not meter per-workflow spend. The turn cap is still ' +
      'enforced.',
  ]
}

/**
 * Which caps `usage` has reached. Pure, so the same figures always produce the
 * same answer whether they arrive from a heartbeat, a result frame or a test.
 *
 * The turn cap is checked first: it is the one that is always enforceable, and
 * where both are reached at once it is the one that names the stop.
 */
export const evaluateCaps = (limits: CapLimits, usage: AgentUsage): CapEvaluation => {
  const breaches: CapBreach[] = []

  if (isUsableLimit(limits.turnCap) && usage.turns >= limits.turnCap) {
    breaches.push({ cap: 'turn', limit: limits.turnCap, used: usage.turns, advisory: false })
  }

  if (isUsableLimit(limits.spendCapUsd) && usage.spendUsd >= limits.spendCapUsd) {
    breaches.push({
      cap: 'spend',
      limit: limits.spendCapUsd,
      used: usage.spendUsd,
      advisory: !limits.spendCapsEnforceable,
    })
  }

  const enforced = breaches.find((breach) => !breach.advisory)

  return {
    breaches,
    ...(enforced === undefined ? {} : { enforced }),
    advisory: breaches.filter((breach) => breach.advisory),
  }
}

const describeBreach = (breach: CapBreach): string =>
  breach.cap === 'turn'
    ? `turn cap reached (${breach.used} of ${breach.limit} turns)`
    : `spend cap reached ($${formatSpend(breach.used)} of $${formatSpend(breach.limit)})`

const buildReason = (breaches: readonly CapBreach[], usage: AgentUsage): string => {
  const enforced = breaches.filter((breach) => !breach.advisory).map(describeBreach)
  const advisory = breaches
    .filter((breach) => breach.advisory)
    .map((breach) => `${describeBreach(breach)}, advisory only`)
  const consumption = `${usage.turns} turns and $${formatSpend(usage.spendUsd)} consumed`

  return `Stopped at a turn boundary: ${[...enforced, ...advisory].join('; ')}. ${consumption}.`
}

export const createCapEnforcer = (limits: CapLimits): CapEnforcer => {
  const advisoryNotices = capAdvisoryNotices(limits)
  /**
   * The breaches observed so far, kept so "whichever is reached first" means
   * first in time rather than first in the last evaluation. A cap reached
   * mid-turn still names the stop even if a second cap is reached before the
   * boundary arrives.
   */
  const observed = new Map<CapKind, CapBreach>()
  let stopArmed = false

  const record = (evaluation: CapEvaluation): CapEvaluation => {
    for (const breach of evaluation.breaches) {
      const existing = observed.get(breach.cap)

      observed.set(breach.cap, existing ?? breach)
    }

    if (evaluation.enforced !== undefined) {
      stopArmed = true
    }

    return evaluation
  }

  return {
    observe: (usage: AgentUsage): CapEvaluation => record(evaluateCaps(limits, usage)),

    checkBoundary: (usage: AgentUsage): CapDecision => {
      record(evaluateCaps(limits, usage))

      if (!stopArmed) {
        return {
          action: 'continue',
          advisory: [...observed.values()].filter((breach) => breach.advisory),
        }
      }

      const breaches = [...observed.values()]

      return {
        action: 'stop',
        breaches,
        consumption: usage,
        preserveWorkInProgress: true,
        report: {
          outcome: 'capped',
          reason: buildReason(breaches, usage),
          turnsUsed: usage.turns,
          spendUsed: formatSpend(usage.spendUsd),
        },
      }
    },

    get isStopArmed() {
      return stopArmed
    },

    advisoryNotices,
  }
}
