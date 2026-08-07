import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { MachineCredential } from '../context'

import {
  isTerminalState,
  loadMachineWorkflow,
  requireEntryInWorkflow,
  resolveOptionalEntry,
} from './guard'
import type { MachineFixture } from './test-support'
import { createMachineFixture, readTestDatabaseUrl, refusalOf } from './test-support'

/**
 * The cross-workflow guard (T063) — the machine surface's one authorisation rule.
 *
 * `machineProcedure` has already decided *which* workflow the credential covers. What is proved
 * here is the rest of FR-018: a write naming anything outside that workflow is refused **and
 * recorded as a security event** (SC-014). Refusing without recording would be half the
 * requirement, and it is the half that leaves no evidence — so every negative case below asserts
 * the `cross_workflow_write` denial as well as the error.
 */

const connectionString = readTestDatabaseUrl()

describe('isTerminalState', () => {
  it('recognises every recorded outcome, including parked_resumable', () => {
    expect(isTerminalState('succeeded')).toBe(true)
    expect(isTerminalState('parked_resumable')).toBe(true)
  })

  it('does not treat a live state as terminal', () => {
    expect(isTerminalState('running')).toBe(false)
    expect(isTerminalState('queued')).toBe(false)
    expect(isTerminalState('paused')).toBe(false)
  })
})

describe.skipIf(connectionString === undefined)('the machine write guard', () => {
  let fixture: MachineFixture
  let credentialA: MachineCredential

  beforeAll(async () => {
    fixture = createMachineFixture(connectionString ?? '')
    await fixture.open()
    // One live credential per workflow is a partial unique index, so it is seeded once and the
    // contexts below are built from it.
    credentialA = await fixture.seedCredential(fixture.ids().a.workflowId)
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  const contextForA = () => fixture.contextFor(credentialA)

  describe('loadMachineWorkflow', () => {
    it('returns the workflow the credential covers', async () => {
      const { ctx } = contextForA()

      await expect(loadMachineWorkflow(ctx)).resolves.toMatchObject({
        id: fixture.ids().a.workflowId,
      })
    })

    it('is NOT_FOUND when the run has gone, rather than silently succeeding', async () => {
      const { ctx } = fixture.contextFor({
        credentialId: randomUUID(),
        workflowId: randomUUID(),
        jti: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      })

      await expect(loadMachineWorkflow(ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  })

  describe('requireEntryInWorkflow', () => {
    it('accepts an entry belonging to the credential’s own run', async () => {
      const { ctx, denials } = contextForA()

      await expect(
        requireEntryInWorkflow(ctx, fixture.ids().a.workflowEntryId, 'machine.test'),
      ).resolves.toBe(fixture.ids().a.workflowEntryId)
      expect(denials).toStrictEqual([])
    })

    it('refuses an entry belonging to another workflow, and records it (FR-018, SC-014)', async () => {
      const { ctx, denials } = contextForA()

      await expect(
        requireEntryInWorkflow(ctx, fixture.ids().b.workflowEntryId, 'machine.test'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })

      expect(denials).toHaveLength(1)
      expect(denials[0]).toMatchObject({
        reason: 'cross_workflow_write',
        workflowId: fixture.ids().a.workflowId,
        path: 'machine.test',
      })
    })

    it('refuses an entry that does not exist identically, so it is not an id oracle', async () => {
      const crossWorkflow = contextForA()
      const unknownEntry = contextForA()

      const forOtherRun = await refusalOf(() =>
        requireEntryInWorkflow(crossWorkflow.ctx, fixture.ids().b.workflowEntryId, 'p'),
      )
      const forUnknown = await refusalOf(() =>
        requireEntryInWorkflow(unknownEntry.ctx, randomUUID(), 'p'),
      )

      expect(forOtherRun.code).toBe('FORBIDDEN')
      expect(forOtherRun.code).toBe(forUnknown.code)
      expect(forOtherRun.message).toBe(forUnknown.message)
      // Both recorded: an executor probing for entry ids leaves a trail either way.
      expect(crossWorkflow.denials).toHaveLength(1)
      expect(unknownEntry.denials).toHaveLength(1)
    })
  })

  describe('resolveOptionalEntry', () => {
    it('answers null when the payload named no entry', async () => {
      const { ctx, denials } = contextForA()

      await expect(resolveOptionalEntry(ctx, undefined, 'machine.test')).resolves.toBeNull()
      expect(denials).toStrictEqual([])
    })

    it('checks the entry when the payload did name one', async () => {
      const { ctx } = contextForA()

      await expect(
        resolveOptionalEntry(ctx, fixture.ids().b.workflowEntryId, 'machine.test'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })
  })
})
