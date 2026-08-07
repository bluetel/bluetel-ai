import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { MachineFixture } from './test-support'
import { createMachineFixture, readTestDatabaseUrl } from './test-support'

/**
 * The machine fixture, tested for the two properties every suite above depends on: that a seeded
 * credential really is pinned to one run, and that `recordDenial` really keeps what it was given —
 * because a fixture that silently dropped denials would let every "and records it" assertion pass
 * against a surface that recorded nothing.
 */

const connectionString = readTestDatabaseUrl()

describe.skipIf(connectionString === undefined)('createMachineFixture', () => {
  let fixture: MachineFixture

  beforeAll(async () => {
    fixture = createMachineFixture(connectionString ?? '')
    await fixture.open()
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  it('seeds a live credential pinned to one workflow', async () => {
    const credential = await fixture.seedCredential(fixture.ids().a.workflowId)

    expect(credential.workflowId).toBe(fixture.ids().a.workflowId)
    expect(credential.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('builds a context carrying that credential and nothing interactive', () => {
    const { ctx } = fixture.contextFor({
      credentialId: 'c',
      workflowId: fixture.ids().b.workflowId,
      jti: 'j',
      expiresAt: new Date(Date.now() + 1000),
    })

    expect(ctx.workflowId).toBe(fixture.ids().b.workflowId)
  })

  it('keeps every denial recorded through it', async () => {
    const { ctx, denials } = fixture.contextFor({
      credentialId: 'c',
      workflowId: fixture.ids().a.workflowId,
      jti: 'j',
      expiresAt: new Date(Date.now() + 1000),
    })

    await ctx.dependencies.recordDenial({ reason: 'cross_workflow_write', path: 'probe' })

    expect(denials).toStrictEqual([{ reason: 'cross_workflow_write', path: 'probe' }])
  })

  it('resolves no human session, because this surface refuses one', async () => {
    const { ctx } = fixture.contextFor({
      credentialId: 'c',
      workflowId: fixture.ids().a.workflowId,
      jti: 'j',
      expiresAt: new Date(Date.now() + 1000),
    })

    await expect(ctx.dependencies.resolveSession(new Headers())).resolves.toBeNull()
  })
})
