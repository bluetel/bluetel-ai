import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { artifacts } from '../../db'
import type { MachineCredential } from '../context'

import { registerArtifact } from './artifacts'
import type { MachineFixture } from './test-support'
import { createMachineFixture, readTestDatabaseUrl, refusalOf } from './test-support'

/**
 * `registerArtifact` (T063) — what the run produced, recorded against the credential's workflow
 * and no other (FR-014, FR-018, SC-012).
 */

const connectionString = readTestDatabaseUrl()

describe.skipIf(connectionString === undefined)('registerArtifact', () => {
  let fixture: MachineFixture
  let credential: MachineCredential

  beforeAll(async () => {
    fixture = createMachineFixture(connectionString ?? '')
    await fixture.open()
    credential = await fixture.seedCredential(fixture.ids().a.workflowId)
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  it('records an external artifact against the credential’s workflow', async () => {
    const { ctx } = fixture.contextFor(credential)

    const artifact = await registerArtifact(ctx, {
      kind: 'pull_request',
      externalUrl: 'https://git.test/a/pull/9',
    })

    expect(artifact.workflowId).toBe(fixture.ids().a.workflowId)
    expect(artifact.externalUrl).toBe('https://git.test/a/pull/9')
    expect(artifact.s3Key).toBeNull()
  })

  it('records a stored artifact with its size', async () => {
    const { ctx } = fixture.contextFor(credential)

    const artifact = await registerArtifact(ctx, {
      kind: 'diff',
      s3Key: 'artifacts/diff.patch',
      byteSize: 4096,
    })

    expect(artifact.s3Key).toBe('artifacts/diff.patch')
    expect(artifact.byteSize).toBe(4096)
    expect(artifact.externalUrl).toBeNull()
  })

  it('attaches an artifact to an entry of its own run', async () => {
    const { ctx } = fixture.contextFor(credential)

    const artifact = await registerArtifact(ctx, {
      kind: 'report',
      entryId: fixture.ids().a.workflowEntryId,
      s3Key: 'artifacts/report.md',
    })

    expect(artifact.entryId).toBe(fixture.ids().a.workflowEntryId)
  })

  it('refuses an artifact that is neither stored nor linked', async () => {
    const { ctx } = fixture.contextFor(credential)

    await expect(registerArtifact(ctx, { kind: 'report' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('refuses an artifact that claims to be both', async () => {
    const { ctx } = fixture.contextFor(credential)

    await expect(
      registerArtifact(ctx, {
        kind: 'report',
        s3Key: 'artifacts/report.md',
        externalUrl: 'https://git.test/a/report',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('refuses an entry belonging to another workflow, and records it (FR-018, SC-014)', async () => {
    const { ctx, denials } = fixture.contextFor(credential)

    await expect(
      registerArtifact(ctx, {
        kind: 'pull_request',
        entryId: fixture.ids().b.workflowEntryId,
        externalUrl: 'https://git.test/b/pull/1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    expect(denials).toHaveLength(1)
    expect(denials[0]).toMatchObject({
      reason: 'cross_workflow_write',
      workflowId: fixture.ids().a.workflowId,
      path: 'machine.registerArtifact',
    })
  })

  it('writes nothing to the other workflow when the entry check refuses', async () => {
    const rows = await fixture
      .db()
      .select()
      .from(artifacts)
      .where(eq(artifacts.workflowId, fixture.ids().b.workflowId))

    // The fixture seeds exactly one artifact per world; a refused write must not have added a
    // second.
    expect(rows).toHaveLength(1)
  })

  it('refuses an unknown entry identically, so it is not an id oracle', async () => {
    const crossWorkflow = fixture.contextFor(credential)
    const unknown = fixture.contextFor(credential)

    const forOtherRun = await refusalOf(() =>
      registerArtifact(crossWorkflow.ctx, {
        kind: 'report',
        entryId: fixture.ids().b.workflowEntryId,
        s3Key: 'artifacts/x.md',
      }),
    )
    const forUnknown = await refusalOf(() =>
      registerArtifact(unknown.ctx, {
        kind: 'report',
        entryId: randomUUID(),
        s3Key: 'artifacts/x.md',
      }),
    )

    expect(forOtherRun.code).toBe(forUnknown.code)
    expect(forOtherRun.message).toBe(forUnknown.message)
  })
})
