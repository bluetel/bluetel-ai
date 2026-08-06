import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { scopedCredentials, workflows } from '../../db'
import type { MachineCredential } from '../context'

import { CREDENTIAL_RENEWAL_WINDOW_MS, renewCredential } from './credential'
import type { MachineFixture } from './test-support'
import { createMachineFixture, readTestDatabaseUrl } from './test-support'

/**
 * `renewCredential` (T063, FR-037).
 *
 * A long run outlives a short credential, and the requirement is that it does so **without any
 * long-lived credential ever existing**. So renewal moves the expiry on the `scoped_credentials`
 * row the caller is already authenticated against, and returns no secret material: nothing new
 * crosses the wire, so nothing new lands in a retry buffer or in an executor's memory while the
 * surface is unreachable.
 *
 * What it must not be able to do — mint, widen, revive a revoked credential, or keep a finished
 * run alive — is what the negative cases below hold in place.
 */

const connectionString = readTestDatabaseUrl()

describe.skipIf(connectionString === undefined)('renewCredential', () => {
  let fixture: MachineFixture
  let credential: MachineCredential
  /** The other run's credential. One live credential per workflow is a partial unique index. */
  let otherCredential: MachineCredential

  beforeAll(async () => {
    fixture = createMachineFixture(connectionString ?? '')
    await fixture.open()
    credential = await fixture.seedCredential(fixture.ids().a.workflowId)
    otherCredential = await fixture.seedCredential(fixture.ids().b.workflowId)
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  it('moves the expiry to a fixed window from now and counts the renewal', async () => {
    const { ctx } = fixture.contextFor(credential)
    const now = new Date('2026-06-01T12:00:00.000Z')

    const renewed = await renewCredential(ctx, now)

    expect(renewed.expiresAt.getTime()).toBe(now.getTime() + CREDENTIAL_RENEWAL_WINDOW_MS)
    expect(renewed.renewalCount).toBe(1)
    expect(renewed.credentialId).toBe(credential.credentialId)
  })

  it('returns the same jti, so nothing secret is minted or handed back', async () => {
    const { ctx } = fixture.contextFor(credential)

    const renewed = await renewCredential(ctx)

    expect(renewed.jti).toBe(credential.jti)
    expect(Object.keys(renewed).sort()).toStrictEqual([
      'credentialId',
      'expiresAt',
      'jti',
      'renewalCount',
    ])
  })

  it('buys the window from now rather than adding to the old expiry', async () => {
    const { ctx } = fixture.contextFor(credential)
    const first = new Date('2026-06-01T12:00:00.000Z')
    const later = new Date('2026-06-01T12:10:00.000Z')

    await renewCredential(ctx, first)
    const second = await renewCredential(ctx, later)

    // Otherwise a run that renewed often would accumulate an arbitrarily long-lived credential,
    // which is the thing FR-037 forbids.
    expect(second.expiresAt.getTime()).toBe(later.getTime() + CREDENTIAL_RENEWAL_WINDOW_MS)
  })

  it('refuses an unrecognised credential', async () => {
    const { ctx } = fixture.contextFor({
      credentialId: randomUUID(),
      workflowId: fixture.ids().a.workflowId,
      jti: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })

    await expect(renewCredential(ctx)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('refuses to renew a credential whose row names another workflow, and records it', async () => {
    // The context claims workflow A while the stored row says workflow B — the shape a confused
    // or forged credential would have.
    const { ctx, denials } = fixture.contextFor({
      ...otherCredential,
      workflowId: fixture.ids().a.workflowId,
    })

    await expect(renewCredential(ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(denials[0]).toMatchObject({
      reason: 'cross_workflow_write',
      path: 'machine.renewCredential',
    })
  })

  it('refuses a revoked credential rather than undoing the revocation', async () => {
    await fixture
      .db()
      .update(scopedCredentials)
      .set({ revokedAt: new Date() })
      .where(eq(scopedCredentials.id, otherCredential.credentialId))

    const { ctx } = fixture.contextFor(otherCredential)

    await expect(renewCredential(ctx)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('refuses once the run has finished', async () => {
    await fixture
      .db()
      .update(workflows)
      .set({ state: 'succeeded', terminalOutcome: 'succeeded' })
      .where(eq(workflows.id, fixture.ids().a.workflowId))

    const { ctx } = fixture.contextFor(credential)

    await expect(renewCredential(ctx)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
