import { validationRuns, workflows } from '@bluetel-ai/sisyphus-api/db'
import { eq } from 'drizzle-orm'
import { decodeJwt } from 'jose'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createFakeComputeProvisioner, createFakeObjectStore } from '../aws'

import { validationInstanceTag } from './instance-tag'
import type { ValidationJobEnvelope } from './job-envelope'
import { reconcile } from './reconcile'
import {
  abandonStaleValidationRuns,
  completeBundleValidation,
  startBundleValidation,
  terminateFinishedValidationInstances,
  VALIDATION_BUDGET_MS,
} from './validate-bundle'
import { createWorkflowFixtures, readTestDatabaseUrl } from './workflow-fixtures'

/**
 * FR-147's requirement is mostly about **what does not happen**: no workflow row, no ticket, no
 * workspace, no prompt, no agent. So the first test here counts workflow rows before and after,
 * which is the only way to state "this did not loosen the workflow table" as an assertion.
 *
 * The last one is the interaction that would otherwise bite: a validation instance holds no compute
 * lease, so an FR-039 sweep that judged it by the lease table would destroy it mid-`setup.sh`.
 */

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

const SECRET = 'test-signing-secret-not-a-real-one'
const MACHINE_SURFACE_URL = 'https://sisyphus.test/api/machine'
const NOW = new Date('2026-08-05T12:00:00.000Z')

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

describeWithDatabase('validating a setup bundle', () => {
  const fixtures = createWorkflowFixtures(connectionString ?? '')

  beforeAll(() => fixtures.open(), 60_000)
  afterEach(() => fixtures.removeAll())
  afterAll(() => fixtures.close())

  /**
   * The bundle version and the admin to attribute a validation to.
   *
   * Taken from a seeded workflow because the fixture harness creates both as dependencies of one;
   * the workflow itself is then irrelevant and is what the first test counts against.
   */
  const bundleAndTrigger = async (
    label: string,
  ): Promise<{ readonly setupBundleVersionId: string; readonly triggeredByUserId: string }> => {
    const workflowId = await fixtures.seedWorkflow({ label })
    const row = firstRow(
      await fixtures
        .db()
        .select({
          setupBundleVersionId: workflows.setupBundleVersionId,
          triggeredByUserId: workflows.ownerUserId,
        })
        .from(workflows)
        .where(eq(workflows.id, workflowId))
        .limit(1),
    )

    if (row === undefined) {
      throw new Error('The fixture workflow vanished between insert and read.')
    }
    return row
  }

  const start = async (label: string, compute = createFakeComputeProvisioner()) => {
    const { setupBundleVersionId, triggeredByUserId } = await bundleAndTrigger(label)
    return {
      compute,
      result: await startBundleValidation({
        db: fixtures.db(),
        compute,
        machineSurfaceUrl: MACHINE_SURFACE_URL,
        credentialSecret: SECRET,
        setupBundleVersionId,
        triggeredByUserId,
        instanceType: 'fixture.small',
        purchaseMode: 'spot',
        now: () => NOW,
      }),
    }
  }

  it('records the run against the bundle version and creates no workflow row', async () => {
    // Counted after the fixture dependencies exist, so the only row this test could add is one a
    // validation wrote.
    const { setupBundleVersionId, triggeredByUserId } = await bundleAndTrigger('no-workflow')
    const before = (await fixtures.db().select({ id: workflows.id }).from(workflows)).length

    const result = await startBundleValidation({
      db: fixtures.db(),
      compute: createFakeComputeProvisioner(),
      machineSurfaceUrl: MACHINE_SURFACE_URL,
      credentialSecret: SECRET,
      setupBundleVersionId,
      triggeredByUserId,
      instanceType: 'fixture.small',
      purchaseMode: 'spot',
      now: () => NOW,
    })

    expect(result.outcome).toBe('provisioned')
    // FR-147: the whole point. A validation that wrote a workflow row would be the reason
    // `owner_user_id`, `assembled_prompt` and `workspace_version_id` had to become nullable.
    expect((await fixtures.db().select({ id: workflows.id }).from(workflows)).length).toBe(before)

    const run = firstRow(await fixtures.db().select().from(validationRuns))
    expect(run?.outcome).toBeNull()
    expect(run?.endedAt).toBeNull()
    expect(run?.startedAt).toStrictEqual(NOW)
  })

  it('launches with a validation envelope carrying no ticket, workspace or prompt', async () => {
    const { compute, result } = await start('envelope')

    const launch = firstRow(compute.launches)
    const envelope = JSON.parse(launch?.userData ?? '{}') as ValidationJobEnvelope

    expect(envelope.mode).toBe('validation')
    expect(envelope.setupBundle.contentDigest).toBe(`sha256:${fixtures.suffix}`)
    expect(Object.keys(envelope).sort()).toStrictEqual([
      'machineSurfaceUrl',
      'mode',
      'scopedCredential',
      'setupBundle',
    ])

    // Identified by the credential's subject, which is also its instance tag — one fact, one place.
    expect(decodeJwt(envelope.scopedCredential).sub).toBe(
      `validation:${result.outcome === 'provisioned' ? result.validationRunId : ''}`,
    )
  })

  it('tags the instance so the FR-039 sweep can tell it from a leak', async () => {
    const { compute, result } = await start('tag')

    expect(firstRow(compute.launches)?.workflowId).toBe(
      validationInstanceTag(result.outcome === 'provisioned' ? result.validationRunId : ''),
    )
  })

  it('records a launch failure as a failed run naming the phase, rather than raising', async () => {
    const compute = createFakeComputeProvisioner()
    compute.failNextLaunch(new Error('InsufficientInstanceCapacity'))

    const { result } = await start('capacity', compute)

    expect(result.outcome).toBe('provisioning_failed')

    const run = firstRow(await fixtures.db().select().from(validationRuns))
    expect(run?.outcome).toBe('failed')
    // FR-148 has the panel show each bundle's most recent validation result; "it threw" is not one.
    expect(JSON.stringify(run?.phaseResults)).toContain('InsufficientInstanceCapacity')
    expect(run?.endedAt).not.toBeNull()
  })

  it('refuses to validate a bundle version that is not registered', async () => {
    await expect(
      startBundleValidation({
        db: fixtures.db(),
        compute: createFakeComputeProvisioner(),
        machineSurfaceUrl: MACHINE_SURFACE_URL,
        credentialSecret: SECRET,
        setupBundleVersionId: '99999999-9999-9999-9999-999999999999',
        triggeredByUserId: (await bundleAndTrigger('unregistered')).triggeredByUserId,
        instanceType: 'fixture.small',
        purchaseMode: 'spot',
      }),
    ).rejects.toThrow(/not registered/)
  })

  describe('completing a run', () => {
    it('records a pass and destroys the instance', async () => {
      const { compute, result } = await start('pass')
      const validationRunId = result.outcome === 'provisioned' ? result.validationRunId : ''

      const completed = await completeBundleValidation({
        db: fixtures.db(),
        compute,
        validationRunId,
        phaseResults: {
          bundle_download: { outcome: 'succeeded' },
          bundle_verify: { outcome: 'succeeded' },
          bundle_unpack: { outcome: 'succeeded' },
          setup_script: { outcome: 'succeeded', durationMs: 42_000 },
        },
        outputS3Key: `validations/${validationRunId}/setup.log`,
        now: () => NOW,
      })

      expect(completed).toMatchObject({ outcome: 'passed', alreadyRecorded: false })
      expect(compute.terminations).toHaveLength(1)

      const run = firstRow(await fixtures.db().select().from(validationRuns))
      expect(run?.outcome).toBe('passed')
      expect(run?.outputS3Key).toBe(`validations/${validationRunId}/setup.log`)
    })

    it('records a failure when any phase did not succeed', async () => {
      const { compute, result } = await start('fail')
      const validationRunId = result.outcome === 'provisioned' ? result.validationRunId : ''

      const completed = await completeBundleValidation({
        db: fixtures.db(),
        compute,
        validationRunId,
        phaseResults: {
          bundle_download: { outcome: 'succeeded' },
          bundle_verify: { outcome: 'failed', detail: 'digest mismatch' },
        },
      })

      expect(completed.outcome).toBe('failed')
      expect(firstRow(await fixtures.db().select().from(validationRuns))?.outcome).toBe('failed')
    })

    it('reports an unconfirmed output rather than pretending it is durable', async () => {
      const { compute, result } = await start('unconfirmed')
      const validationRunId = result.outcome === 'provisioned' ? result.validationRunId : ''

      const completed = await completeBundleValidation({
        db: fixtures.db(),
        compute,
        validationRunId,
        phaseResults: { setup_script: { outcome: 'succeeded' } },
        outputS3Key: `validations/${validationRunId}/setup.log`,
        objectStore: createFakeObjectStore(),
        outputBucket: 'logs-bucket',
      })

      // The captured output is the entire product of a validation run, so its absence is reported
      // rather than folded into a pass.
      expect(completed.outputUnconfirmed).toBe(true)
    })

    it('does not rewrite a result somebody has already read', async () => {
      const { compute, result } = await start('twice')
      const validationRunId = result.outcome === 'provisioned' ? result.validationRunId : ''
      const phaseResults = { setup_script: { outcome: 'succeeded' } } as const

      await completeBundleValidation({ db: fixtures.db(), compute, validationRunId, phaseResults })
      const second = await completeBundleValidation({
        db: fixtures.db(),
        compute,
        validationRunId,
        phaseResults: { setup_script: { outcome: 'failed' } },
      })

      expect(second.alreadyRecorded).toBe(true)
      expect(firstRow(await fixtures.db().select().from(validationRuns))?.outcome).toBe('passed')
    })
  })

  describe('the budget', () => {
    it('abandons a run whose executor never reported, and destroys its instance', async () => {
      const { compute, result } = await start('stale')
      const validationRunId = result.outcome === 'provisioned' ? result.validationRunId : ''

      const abandoned = await abandonStaleValidationRuns({
        db: fixtures.db(),
        compute,
        now: () => new Date(NOW.getTime() + VALIDATION_BUDGET_MS + 1),
      })

      // The FR-039 sweep deliberately leaves these alone, so without this nothing ends one — and a
      // hung `setup.sh` is exactly what a validation run exists to discover.
      expect(abandoned).toStrictEqual([
        { validationRunId, terminatedInstanceId: firstRow(compute.terminations) },
      ])
      expect(firstRow(await fixtures.db().select().from(validationRuns))?.outcome).toBe('failed')
    })

    it('leaves a run inside its budget alone', async () => {
      const { compute } = await start('fresh')

      const abandoned = await abandonStaleValidationRuns({
        db: fixtures.db(),
        compute,
        now: () => new Date(NOW.getTime() + 60_000),
      })

      expect(abandoned).toStrictEqual([])
      expect(compute.terminations).toStrictEqual([])
    })
  })

  describe('instances of runs that have already reported (T200)', () => {
    it('destroys the instance of a run the machine surface ended', async () => {
      // The gap `machine.reportValidation` opens and this closes. An instance now ends its own run
      // by reporting, from a surface that holds no compute provisioner and must not be given one —
      // so the row is finished and the machine is still up.
      const { compute, result } = await start('reported')
      const validationRunId = result.outcome === 'provisioned' ? result.validationRunId : ''

      // As `reportValidation` leaves it: an outcome, an end time, and nothing else touched.
      await fixtures
        .db()
        .update(validationRuns)
        .set({ outcome: 'passed', endedAt: NOW })
        .where(eq(validationRuns.id, validationRunId))

      const terminated = await terminateFinishedValidationInstances({ db: fixtures.db(), compute })

      expect(terminated).toStrictEqual([
        { validationRunId, terminatedInstanceId: firstRow(compute.terminations) },
      ])
      expect(compute.terminations).toHaveLength(1)
    })

    it('leaves an unfinished run’s instance alone, which is the stale sweep’s business', async () => {
      const { compute } = await start('still-running')

      await expect(
        terminateFinishedValidationInstances({ db: fixtures.db(), compute }),
      ).resolves.toStrictEqual([])
      expect(compute.terminations).toStrictEqual([])
    })

    it('says nothing about a finished run whose instance has already gone', async () => {
      // The ordinary case rather than an error: a validation that reports and exits leaves a machine
      // its own launch unit may shut down before this next runs.
      const { compute, result } = await start('already-gone')
      const validationRunId = result.outcome === 'provisioned' ? result.validationRunId : ''

      await fixtures
        .db()
        .update(validationRuns)
        .set({ outcome: 'failed', endedAt: NOW })
        .where(eq(validationRuns.id, validationRunId))
      await terminateFinishedValidationInstances({ db: fixtures.db(), compute })

      // A second pass finds nothing to do and reports nothing.
      await expect(
        terminateFinishedValidationInstances({ db: fixtures.db(), compute }),
      ).resolves.toStrictEqual([])
    })
  })

  it('survives a reconciliation pass while it is still running', async () => {
    const { compute } = await start('reconciled')

    const swept = await reconcile({ db: fixtures.db(), compute, now: () => NOW })

    expect(swept.validationInstances).toHaveLength(1)
    expect(compute.terminations).toStrictEqual([])
  })
})
