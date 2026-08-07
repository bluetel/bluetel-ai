import { describe, expect, it } from 'vitest'

import type { AgentUsage } from '../agent'

import { capAdvisoryNotices, createCapEnforcer, evaluateCaps, formatSpend } from './enforce'

const usage = (turns: number, spendUsd: number): AgentUsage => ({ turns, spendUsd })

const METERED = { turnCap: 10, spendCapUsd: 5, spendCapsEnforceable: true } as const
const FLAT_RATE = { turnCap: 10, spendCapUsd: 5, spendCapsEnforceable: false } as const

describe('evaluateCaps', () => {
  it('reports nothing below both caps', () => {
    const evaluation = evaluateCaps(METERED, usage(3, 1))

    expect(evaluation.breaches).toStrictEqual([])
    expect(evaluation.enforced).toBeUndefined()
  })

  it('reports the turn cap when it is reached', () => {
    const evaluation = evaluateCaps(METERED, usage(10, 1))

    expect(evaluation.enforced).toStrictEqual({
      cap: 'turn',
      limit: 10,
      used: 10,
      advisory: false,
    })
  })

  it('reports the spend cap when it is reached', () => {
    const evaluation = evaluateCaps(METERED, usage(2, 5.25))

    expect(evaluation.enforced).toStrictEqual({
      cap: 'spend',
      limit: 5,
      used: 5.25,
      advisory: false,
    })
  })

  it('names the turn cap when both are reached at once', () => {
    const evaluation = evaluateCaps(METERED, usage(10, 9))

    expect(evaluation.enforced?.cap).toBe('turn')
    expect(evaluation.breaches.map((breach) => breach.cap)).toStrictEqual(['turn', 'spend'])
  })

  it('marks the spend cap advisory when the bundle cannot meter spend', () => {
    const evaluation = evaluateCaps(FLAT_RATE, usage(2, 9))

    expect(evaluation.enforced).toBeUndefined()
    expect(evaluation.advisory).toStrictEqual([{ cap: 'spend', limit: 5, used: 9, advisory: true }])
  })

  it('still enforces the turn cap under an unmeasurable credential', () => {
    const evaluation = evaluateCaps(FLAT_RATE, usage(10, 0))

    expect(evaluation.enforced?.cap).toBe('turn')
  })

  it('ignores a cap that was not set', () => {
    expect(evaluateCaps({ spendCapsEnforceable: true }, usage(9999, 9999)).breaches).toStrictEqual(
      [],
    )
  })

  it('ignores a nonsensical cap rather than stopping instantly', () => {
    expect(
      evaluateCaps(
        { turnCap: Number.NaN, spendCapUsd: -1, spendCapsEnforceable: true },
        usage(1, 1),
      ).breaches,
    ).toStrictEqual([])
  })

  it('treats a zero turn cap as reached before the first turn', () => {
    expect(
      evaluateCaps({ turnCap: 0, spendCapsEnforceable: true }, usage(0, 0)).enforced?.cap,
    ).toBe('turn')
  })
})

describe('capAdvisoryNotices', () => {
  it('says so when a spend cap is set against an unmeasurable credential', () => {
    const [notice] = capAdvisoryNotices(FLAT_RATE)

    expect(notice).toContain('advisory')
    expect(notice).toContain('turn cap is still')
  })

  it('says nothing when spend is measurable', () => {
    expect(capAdvisoryNotices(METERED)).toStrictEqual([])
  })

  it('says nothing when no spend cap was set at all', () => {
    expect(capAdvisoryNotices({ turnCap: 5, spendCapsEnforceable: false })).toStrictEqual([])
  })
})

describe('createCapEnforcer', () => {
  it('continues while both caps are unreached', () => {
    const enforcer = createCapEnforcer(METERED)

    expect(enforcer.checkBoundary(usage(1, 0.5))).toStrictEqual({
      action: 'continue',
      advisory: [],
    })
    expect(enforcer.isStopArmed).toBe(false)
  })

  it('never stops mid-turn, only arms the stop', () => {
    const enforcer = createCapEnforcer(METERED)
    const evaluation = enforcer.observe(usage(10, 1))

    expect(evaluation.enforced?.cap).toBe('turn')
    expect(enforcer.isStopArmed).toBe(true)
  })

  it('acts on an armed stop at the next boundary', () => {
    const enforcer = createCapEnforcer(METERED)

    enforcer.observe(usage(10, 1))

    const decision = enforcer.checkBoundary(usage(10, 1.5))

    expect(decision.action).toBe('stop')
  })

  it('preserves work in progress and reports capped with the figures', () => {
    const enforcer = createCapEnforcer(METERED)
    const decision = enforcer.checkBoundary(usage(10, 2.5))

    if (decision.action !== 'stop') {
      throw new Error('expected a stop decision')
    }

    expect(decision.preserveWorkInProgress).toBe(true)
    expect(decision.report.outcome).toBe('capped')
    expect(decision.report.turnsUsed).toBe(10)
    expect(decision.report.spendUsed).toBe('2.5000')
    expect(decision.report.reason).toContain('turn cap reached (10 of 10 turns)')
    expect(decision.report.reason).toContain('10 turns and $2.5000 consumed')
  })

  it('stops on whichever cap is reached first', () => {
    const enforcer = createCapEnforcer(METERED)
    const decision = enforcer.checkBoundary(usage(4, 5))

    if (decision.action !== 'stop') {
      throw new Error('expected a stop decision')
    }

    expect(decision.breaches.map((breach) => breach.cap)).toStrictEqual(['spend'])
    expect(decision.report.reason).toContain('spend cap reached')
  })

  it('keeps naming the cap that was reached first when a second follows', () => {
    const enforcer = createCapEnforcer(METERED)

    enforcer.observe(usage(2, 5))

    const decision = enforcer.checkBoundary(usage(10, 6))

    if (decision.action !== 'stop') {
      throw new Error('expected a stop decision')
    }

    expect(decision.breaches[0]).toStrictEqual({
      cap: 'spend',
      limit: 5,
      used: 5,
      advisory: false,
    })
  })

  it('stays stopped once armed', () => {
    const enforcer = createCapEnforcer(METERED)

    enforcer.checkBoundary(usage(10, 1))

    expect(enforcer.checkBoundary(usage(10, 1)).action).toBe('stop')
  })

  describe('when the bundle declares spend unmeasurable', () => {
    it('surfaces the advisory before anything has run', () => {
      expect(createCapEnforcer(FLAT_RATE).advisoryNotices).toHaveLength(1)
    })

    it('continues past an exceeded spend cap and reports it as advisory', () => {
      const enforcer = createCapEnforcer(FLAT_RATE)
      const decision = enforcer.checkBoundary(usage(3, 50))

      expect(decision.action).toBe('continue')
      expect(enforcer.isStopArmed).toBe(false)

      if (decision.action !== 'continue') {
        throw new Error('expected a continue decision')
      }

      expect(decision.advisory).toStrictEqual([
        { cap: 'spend', limit: 5, used: 50, advisory: true },
      ])
    })

    it('still stops on the turn cap', () => {
      const enforcer = createCapEnforcer(FLAT_RATE)
      const decision = enforcer.checkBoundary(usage(10, 50))

      if (decision.action !== 'stop') {
        throw new Error('expected a stop decision')
      }

      expect(decision.report.reason).toContain('turn cap reached')
      expect(decision.report.reason).toContain('advisory only')
    })

    it('reports zero spend without inventing an advisory breach', () => {
      const enforcer = createCapEnforcer(FLAT_RATE)
      const decision = enforcer.checkBoundary(usage(2, 0))

      expect(decision).toStrictEqual({ action: 'continue', advisory: [] })
    })
  })
})

describe('formatSpend', () => {
  it('formats as a decimal the machine surface accepts', () => {
    expect(formatSpend(1.5)).toBe('1.5000')
    expect(formatSpend(0)).toBe('0.0000')
  })

  it('never emits a negative or non-finite amount', () => {
    expect(formatSpend(-3)).toBe('0.0000')
    expect(formatSpend(Number.NaN)).toBe('0.0000')
  })
})
