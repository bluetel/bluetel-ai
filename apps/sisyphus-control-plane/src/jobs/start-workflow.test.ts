import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import {
  bootstrapPhases,
  computeLeases,
  workflowEntries,
  workflowEvents,
  workflows,
  workspaceEntries,
} from '@bluetel-ai/sisyphus-api/db'
import { eq } from 'drizzle-orm'
import { decodeJwt } from 'jose'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { ComputeProvisioner } from '../aws'
import { createFakeComputeProvisioner } from '../aws'
import { liveCredentialFor } from '../credentials'

import type { WorkflowJobEnvelope } from './job-envelope'
import { startWorkflow } from './start-workflow'
import { createWorkflowFixtures, readTestDatabaseUrl } from './workflow-fixtures'

/**
 * **Every test here runs against `createFakeComputeProvisioner`.** Nothing in this file, or
 * anything it imports, constructs an AWS client — the adapters in `src/aws` are handed one, and the
 * fake is the one handed here. That is the entire reason T054 exists, and it is what makes it
 * possible to test the code that launches EC2 instances without launching one.
 *
 * The assertions worth reading twice are the two about the envelope: that it carries the whole job
 * specification, and that the *only* credential in it is the short-lived scoped one.
 */

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

const SECRET = 'test-signing-secret-not-a-real-one'
const MACHINE_SURFACE_URL = 'https://sisyphus.test/api/machine'

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * Give a fixture workflow the workspace entries provisioning refuses to launch without.
 *
 * The fixture harness seeds a workspace *version* but no entries, because admission never looks at
 * them. Provisioning does, so this fills the gap without touching the shared harness.
 */
const seedEntry = async (
  db: SisyphusDatabase,
  workflowId: string,
  entry: {
    readonly subdirectory: string
    readonly repositoryUrl?: string
    readonly baseBranch?: string
    readonly isPrimary?: boolean
    readonly position?: number
  },
): Promise<string> => {
  const workflow = firstRow(
    await db
      .select({ workspaceVersionId: workflows.workspaceVersionId })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1),
  )

  if (workflow === undefined) {
    throw new Error(`No workflow ${workflowId} to attach an entry to.`)
  }

  const repositoryUrl = entry.repositoryUrl ?? `https://example.invalid/${entry.subdirectory}.git`
  const baseBranch = entry.baseBranch ?? 'main'
  const isPrimary = entry.isPrimary ?? true

  const workspaceEntry = firstRow(
    await db
      .insert(workspaceEntries)
      .values({
        workspaceVersionId: workflow.workspaceVersionId,
        repositoryUrl,
        baseBranch,
        subdirectory: entry.subdirectory,
        isPrimary,
        position: entry.position ?? 0,
      })
      .returning({ id: workspaceEntries.id }),
  )

  if (workspaceEntry === undefined) {
    throw new Error('Seeding a workspace entry returned no row.')
  }

  const workflowEntry = firstRow(
    await db
      .insert(workflowEntries)
      .values({
        workflowId,
        workspaceEntryId: workspaceEntry.id,
        repositoryUrl,
        baseBranch,
        subdirectory: entry.subdirectory,
        isPrimary,
      })
      .returning({ id: workflowEntries.id }),
  )

  if (workflowEntry === undefined) {
    throw new Error('Seeding a workflow entry returned no row.')
  }

  return workflowEntry.id
}

describeWithDatabase('provisioning an admitted workflow', () => {
  const fixtures = createWorkflowFixtures(connectionString ?? '')

  beforeAll(() => fixtures.open(), 60_000)
  afterEach(() => fixtures.removeAll())
  afterAll(() => fixtures.close())

  /** A workflow admitted as far as `provisioning`, with a live lease and one workspace entry. */
  const admittedWorkflow = async (options: {
    readonly label: string
    readonly instanceType?: string
    readonly purchaseMode?: 'on_demand' | 'spot'
  }): Promise<{ readonly workflowId: string; readonly entryId: string }> => {
    const workflowId = await fixtures.seedWorkflow({
      label: options.label,
      state: 'provisioning',
      instanceType: options.instanceType,
      purchaseMode: options.purchaseMode,
    })
    const entryId = await seedEntry(fixtures.db(), workflowId, { subdirectory: 'app' })

    await fixtures
      .db()
      .insert(computeLeases)
      .values({
        workflowId,
        instanceType: options.instanceType ?? 'fixture.small',
        purchaseMode: options.purchaseMode ?? 'spot',
      })

    return { workflowId, entryId }
  }

  const start = (
    workflowId: string,
    compute: ComputeProvisioner = createFakeComputeProvisioner(),
  ) =>
    startWorkflow({
      db: fixtures.db(),
      compute,
      machineSurfaceUrl: MACHINE_SURFACE_URL,
      credentialSecret: SECRET,
      workflowId,
    })

  it('launches one instance and records it on the lease', async () => {
    const { workflowId } = await admittedWorkflow({ label: 'launch' })
    const compute = createFakeComputeProvisioner({ instanceIds: ['i-0abc'] })

    const outcome = await start(workflowId, compute)

    expect(outcome).toMatchObject({ outcome: 'started', instanceId: 'i-0abc' })
    expect(compute.launches).toHaveLength(1)

    const lease = firstRow(
      await fixtures
        .db()
        .select()
        .from(computeLeases)
        .where(eq(computeLeases.workflowId, workflowId)),
    )
    expect(lease?.providerInstanceId).toBe('i-0abc')
    expect(lease?.readyAt).not.toBeNull()
  })

  it('sizes and prices the instance from the job spec rather than from a default here', async () => {
    const { workflowId } = await admittedWorkflow({
      label: 'spec',
      instanceType: 'c7i.4xlarge',
      purchaseMode: 'on_demand',
    })
    const compute = createFakeComputeProvisioner()

    await start(workflowId, compute)

    // `on_demand` survives, which is the case a default would silently overwrite: spot is the
    // platform default, and a run that asked for reserved capacity getting interruptible capacity
    // is a correctness failure that only shows up as an unexplained interruption.
    expect(firstRow(compute.launches)).toMatchObject({
      instanceType: 'c7i.4xlarge',
      purchaseMode: 'on_demand',
      workflowId,
    })
  })

  it('carries every job parameter in the user-data envelope', async () => {
    const { workflowId, entryId } = await admittedWorkflow({ label: 'envelope' })
    const compute = createFakeComputeProvisioner()

    await start(workflowId, compute)

    const envelope = JSON.parse(firstRow(compute.launches)?.userData ?? '{}') as WorkflowJobEnvelope

    expect(envelope.mode).toBe('workflow')
    expect(envelope.workflowId).toBe(workflowId)
    expect(envelope.machineSurfaceUrl).toBe(MACHINE_SURFACE_URL)
    expect(envelope.workspace.root).toBe('/workspace')
    expect(envelope.workspace.entries).toStrictEqual([
      {
        entryId,
        repositoryUrl: 'https://example.invalid/app.git',
        baseBranch: 'main',
        subdirectory: 'app',
        isPrimary: true,
      },
    ])
    expect(envelope.job).toMatchObject({ model: 'claude-sonnet-5', workflowType: 'delegated' })
    expect(envelope.prompt.assembled).toContain('Fixture prompt envelope')
    expect(envelope.setupBundle.contentDigest).toBe(`sha256:${fixtures.suffix}`)
  })

  it('puts a short-lived, workflow-scoped credential in the envelope and no long-lived secret', async () => {
    const { workflowId } = await admittedWorkflow({ label: 'credential' })
    const compute = createFakeComputeProvisioner()

    await start(workflowId, compute)

    const userData = firstRow(compute.launches)?.userData ?? ''
    const envelope = JSON.parse(userData) as WorkflowJobEnvelope
    const claims = decodeJwt(envelope.scopedCredential)

    expect(claims.sub).toBe(`workflow:${workflowId}`)
    expect(claims.aud).toBe('sisyphus-machine-surface')

    // The signing secret is what would let the instance mint credentials for other runs. It is
    // never in the envelope — only what it signed is.
    expect(userData).not.toContain(SECRET)

    const stored = await liveCredentialFor(fixtures.db(), workflowId)
    expect(stored?.jti).toBe(claims.jti)
  })

  it('records the provisioning bootstrap phase, so the panel is never opaquely provisioning', async () => {
    const { workflowId } = await admittedWorkflow({ label: 'phase' })

    await start(workflowId)

    const phases = await fixtures
      .db()
      .select()
      .from(bootstrapPhases)
      .where(eq(bootstrapPhases.workflowId, workflowId))

    expect(phases).toHaveLength(1)
    expect(phases[0]).toMatchObject({ phase: 'provisioning', outcome: 'succeeded', sequence: 1 })
  })

  it('records the provisioned event with the cost basis', async () => {
    const { workflowId } = await admittedWorkflow({ label: 'event' })

    await start(workflowId)

    const events = await fixtures
      .db()
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowId, workflowId))

    expect(events.map((event) => event.event)).toContain('provisioned')
  })

  describe('when the launch fails', () => {
    it('leaves the lease intact for the reconciler and rethrows for startFailures', async () => {
      const { workflowId } = await admittedWorkflow({ label: 'capacity' })
      const compute = createFakeComputeProvisioner()
      compute.failNextLaunch(new Error('InsufficientInstanceCapacity'))

      await expect(start(workflowId, compute)).rejects.toThrow(/InsufficientInstanceCapacity/)

      // The lease stands. Releasing it here would be the control plane deciding a capacity refusal
      // means the run is over, which is the reconciler's call to make, not this job's.
      const lease = firstRow(
        await fixtures
          .db()
          .select()
          .from(computeLeases)
          .where(eq(computeLeases.workflowId, workflowId)),
      )
      expect(lease?.releasedAt).toBeNull()
      expect(lease?.providerInstanceId).toBeNull()
    })

    it('revokes the credential it minted for an instance that never booted', async () => {
      const { workflowId } = await admittedWorkflow({ label: 'revoke-on-failure' })
      const compute = createFakeComputeProvisioner()
      compute.failNextLaunch(new Error('InsufficientInstanceCapacity'))

      await expect(start(workflowId, compute)).rejects.toThrow()

      expect(await liveCredentialFor(fixtures.db(), workflowId)).toBeUndefined()
    })

    it('records the failure against the named provisioning phase', async () => {
      const { workflowId } = await admittedWorkflow({ label: 'failed-phase' })
      const compute = createFakeComputeProvisioner()
      compute.failNextLaunch(new Error('InsufficientInstanceCapacity'))

      await expect(start(workflowId, compute)).rejects.toThrow()

      const phases = await fixtures
        .db()
        .select()
        .from(bootstrapPhases)
        .where(eq(bootstrapPhases.workflowId, workflowId))

      expect(phases[0]).toMatchObject({ phase: 'provisioning', outcome: 'failed' })
      expect(phases[0]?.detail).toContain('InsufficientInstanceCapacity')
    })
  })

  describe('when it is reached twice', () => {
    it('does not launch a second instance for a lease that already records one', async () => {
      const { workflowId } = await admittedWorkflow({ label: 'retry' })
      const compute = createFakeComputeProvisioner({ instanceIds: ['i-first', 'i-second'] })

      await start(workflowId, compute)
      const second = await start(workflowId, compute)

      // FR-078. One admission, one instance, however many times the hand-off is retried.
      expect(second).toMatchObject({ outcome: 'already_started', instanceId: 'i-first' })
      expect(compute.launches).toHaveLength(1)
    })

    it('destroys the instance it launched when it loses the claim on the lease', async () => {
      const { workflowId } = await admittedWorkflow({ label: 'race' })
      const fake = createFakeComputeProvisioner({ instanceIds: ['i-loser'] })

      // The interleaving the compare-and-set exists for: another caller records *its* instance
      // between this one reading the lease and updating it. Injected at the launch, because that
      // is the window — the read has happened and the update has not.
      const racing: ComputeProvisioner = {
        ...fake,
        launch: async (request) => {
          await fixtures
            .db()
            .update(computeLeases)
            .set({ providerInstanceId: 'i-winner', readyAt: new Date() })
            .where(eq(computeLeases.workflowId, workflowId))
          return fake.launch(request)
        },
      }

      const outcome = await start(workflowId, racing)

      expect(outcome).toMatchObject({
        outcome: 'already_started',
        instanceId: 'i-winner',
        terminatedInstanceId: 'i-loser',
      })
      // Nobody else knows `i-loser` exists, so the loser is the only party that can destroy it.
      expect(fake.terminations).toStrictEqual(['i-loser'])
    })
  })

  it('refuses a run holding no live lease rather than launching an unaccounted instance', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'no-lease', state: 'provisioning' })
    const compute = createFakeComputeProvisioner()

    const outcome = await start(workflowId, compute)

    expect(outcome).toMatchObject({ outcome: 'not_startable' })
    expect(compute.launches).toHaveLength(0)
  })

  it('refuses a run with no workspace entries before an instance is paid for', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'no-entries', state: 'provisioning' })
    await fixtures.db().insert(computeLeases).values({
      workflowId,
      instanceType: 'fixture.small',
      purchaseMode: 'spot',
    })
    const compute = createFakeComputeProvisioner()

    await expect(start(workflowId, compute)).rejects.toThrow(/no workspace entries/)
    expect(compute.launches).toHaveLength(0)
  })
})
