import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'

import type { ExecutionProfileVersion } from '../../db'

import { lockedFieldError, OVERRIDABLE_FIELDS, resolveLaunchPlan } from './launch-plan'

/**
 * The rule that decides what configuration a run actually gets (FR-122, FR-123).
 *
 * Pure, so it is tested exhaustively rather than incidentally: every overridable field is covered
 * both accepted and locked, because a field that silently ignored its lock would start a run whose
 * settings disagree with what the person who launched it believes they asked for — and they would
 * find out from the bill.
 */

const versionOf = (overrides: Partial<ExecutionProfileVersion> = {}): ExecutionProfileVersion => ({
  id: '33333333-3333-7333-8333-333333333333',
  executionProfileId: '44444444-4444-7444-8444-444444444444',
  version: 1,
  workspaceVersionId: '55555555-5555-7555-8555-555555555555',
  setupBundleVersionId: '66666666-6666-7666-8666-666666666666',
  model: 'claude-opus-5',
  instanceType: 'm7i.large',
  purchaseMode: 'spot',
  turnCap: 40,
  spendCap: '25.0000',
  defaultWorkflowType: 'delegated',
  promptPreamble: 'Preamble.',
  lockedFields: [],
  createdByUserId: '77777777-7777-7777-8777-777777777777',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
})

describe('resolveLaunchPlan', () => {
  it('produces a complete spec from the profile alone (FR-122)', () => {
    // "Select a profile, type a prompt, go" has to reach here with nothing else supplied.
    const plan = resolveLaunchPlan(versionOf(), undefined)

    expect(plan).toMatchObject({
      workflowType: 'delegated',
      model: 'claude-opus-5',
      instanceType: 'm7i.large',
      purchaseMode: 'spot',
      turnCap: 40,
      spendCap: '25.0000',
      overrides: [],
    })
  })

  it('pins the bundle and workspace versions the profile version carries, not their parents', () => {
    const version = versionOf()
    const plan = resolveLaunchPlan(version, undefined)

    expect(plan.workspaceVersionId).toBe(version.workspaceVersionId)
    expect(plan.setupBundleVersionId).toBe(version.setupBundleVersionId)
    expect(plan.executionProfileVersionId).toBe(version.id)
  })

  it('applies an override and records both values (FR-123)', () => {
    const plan = resolveLaunchPlan(versionOf(), { instanceType: 'm7i.4xlarge' })

    expect(plan.instanceType).toBe('m7i.4xlarge')
    expect(plan.overrides).toStrictEqual([
      { field: 'instanceType', profileValue: 'm7i.large', usedValue: 'm7i.4xlarge' },
    ])
  })

  it('records a null profile value as null rather than as the string "null"', () => {
    const plan = resolveLaunchPlan(versionOf({ turnCap: null }), { turnCap: 12 })

    expect(plan.overrides).toStrictEqual([
      { field: 'turnCap', profileValue: null, usedValue: '12' },
    ])
  })

  it('does not record an "override" that restates the profile’s own value', () => {
    // The launch form prefills every field, so it submits matching values far more often than it
    // submits changes; recording those would pad the trail with non-events.
    const plan = resolveLaunchPlan(versionOf(), { model: 'claude-opus-5' })

    expect(plan.model).toBe('claude-opus-5')
    expect(plan.overrides).toStrictEqual([])
  })

  it('refuses a locked field rather than ignoring it (FR-123)', () => {
    expect(() =>
      resolveLaunchPlan(versionOf({ lockedFields: ['instanceType'] }), {
        instanceType: 'm7i.4xlarge',
      }),
    ).toThrow(TRPCError)
  })

  it('names the locked field, because the panel has to say which control to put back', () => {
    const error = lockedFieldError('spendCap')

    expect(error.code).toBe('BAD_REQUEST')
    expect(error.message).toContain('spendCap')
  })

  it('does not refuse a locked field the caller did not try to override', () => {
    const plan = resolveLaunchPlan(versionOf({ lockedFields: ['instanceType'] }), {
      turnCap: 5,
    })

    expect(plan.instanceType).toBe('m7i.large')
    expect(plan.turnCap).toBe(5)
  })

  /** Every field, both ways. A gap here is a field whose lock has never been exercised. */
  describe('each overridable field', () => {
    const values = {
      model: 'claude-sonnet-5',
      instanceType: 'c7i.xlarge',
      purchaseMode: 'on_demand',
      turnCap: 99,
      spendCap: '1.0000',
      workflowType: 'autonomous',
    } as const

    for (const field of OVERRIDABLE_FIELDS) {
      it(`${field}: accepted when unlocked`, () => {
        const plan = resolveLaunchPlan(versionOf(), { [field]: values[field] })

        expect(plan.overrides.map((override) => override.field)).toStrictEqual([field])
      })

      it(`${field}: refused when locked`, () => {
        expect(() =>
          resolveLaunchPlan(versionOf({ lockedFields: [field] }), { [field]: values[field] }),
        ).toThrow(/locks/)
      })
    }
  })
})
