import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { setupBundleVersions, validationCredentials, validationRuns } from '../../db'
import type { ReportValidationInput } from '../../schemas'
import { reportValidationInput } from '../../schemas'
import type { UserFixtures } from '../admin/test-database'
import { createUserFixtures, readTestDatabaseUrl } from '../admin/test-database'
import type { ValidationRunCredential } from '../context'

import type { ValidationContext } from './validation'
import { reportValidation, validationOutcomeFor, validationPhaseResults } from './validation'

/**
 * `machine.reportValidation` (T200, FR-147, FR-148).
 *
 * The derivation and the reshaping are pure and are asserted directly; everything else needs a
 * database, because the claims are about what a **conditional update** does — first report wins on
 * `ended_at is null`, and the credential is retired in the same transaction. Neither is observable
 * against a fake.
 */

const connectionString = readTestDatabaseUrl()

const succeeded = (phase: ReportValidationInput['phaseResults'][number]['phase']) =>
  ({ phase, outcome: 'succeeded' }) as const

describe('deriving the outcome from the phases', () => {
  it('passes only when every reported phase succeeded (FR-148)', () => {
    expect(
      validationOutcomeFor([
        succeeded('provisioning'),
        succeeded('bundle_download'),
        succeeded('setup_script'),
      ]),
    ).toBe('passed')
  })

  it('fails on a phase that failed, and on one that timed out', () => {
    expect(
      validationOutcomeFor([
        succeeded('provisioning'),
        { phase: 'setup_script', outcome: 'failed' },
      ]),
    ).toBe('failed')
    expect(
      validationOutcomeFor([
        succeeded('provisioning'),
        { phase: 'setup_script', outcome: 'timed_out' },
      ]),
    ).toBe('failed')
  })

  it('does not treat an unreported phase as a failure', () => {
    // A run that stopped at `bundle_verify` never had a `setup_script` phase to report, and
    // counting the absence would report two failures for one fault.
    expect(validationOutcomeFor([succeeded('provisioning'), succeeded('bundle_download')])).toBe(
      'passed',
    )
  })

  it('cannot derive passed from an empty report, because the schema forbids one', () => {
    // The one leniency that would be dangerous: `validationOutcomeFor([])` is vacuously `passed`,
    // so the guard is the input schema rather than a special case in the derivation.
    expect(validationOutcomeFor([])).toBe('passed')
    expect(reportValidationInput.safeParse({ phaseResults: [] }).success).toBe(false)
  })
})

describe('reshaping the wire array into the stored document', () => {
  it('keys each result by its phase and drops the redundant phase field', () => {
    expect(
      validationPhaseResults([
        { phase: 'bundle_verify', outcome: 'succeeded', durationMs: 12 },
        { phase: 'setup_script', outcome: 'failed', detail: 'exit 1' },
      ]),
    ).toStrictEqual({
      bundle_verify: { outcome: 'succeeded', durationMs: 12 },
      setup_script: { outcome: 'failed', detail: 'exit 1' },
    })
  })
})

describe.skipIf(connectionString === undefined)('reporting a validation, against Postgres', () => {
  const fixtures: UserFixtures = createUserFixtures(connectionString ?? '')
  let ownerId = ''
  let bundleVersionId = ''

  const seedRun = async (): Promise<string> => {
    const [row] = await fixtures
      .db()
      .insert(validationRuns)
      .values({ setupBundleVersionId: bundleVersionId, triggeredByUserId: ownerId })
      .returning({ id: validationRuns.id })
    return row.id
  }

  const seedCredential = async (validationRunId: string): Promise<ValidationRunCredential> => {
    const jti = randomUUID()
    const expiresAt = new Date(Date.now() + 900_000)
    const [row] = await fixtures
      .db()
      .insert(validationCredentials)
      .values({ validationRunId, jti, expiresAt })
      .returning({ id: validationCredentials.id })

    return { credentialId: row.id, validationRunId, jti, expiresAt }
  }

  const contextFor = (credential: ValidationRunCredential): ValidationContext => ({
    db: fixtures.db(),
    validationRunId: credential.validationRunId,
    credential,
  })

  beforeAll(async () => {
    await fixtures.open()
    const owner = await fixtures.seedUser({ label: 'validation-reporter', role: 'admin' })
    ownerId = owner.id
    // Creates the bundle and its version, which `validation_runs` cannot exist without.
    await fixtures.seedWorkflow({ ownerUserId: ownerId, state: 'running' })

    const [version] = await fixtures
      .db()
      .select({ id: setupBundleVersions.id })
      .from(setupBundleVersions)
      .limit(1)
    bundleVersionId = version.id
  }, 120_000)

  afterAll(async () => {
    await fixtures.close()
  })

  afterEach(async () => {
    await fixtures.db().delete(validationCredentials)
    await fixtures.db().delete(validationRuns)
  })

  it('records the derived outcome, the phases and the output key (FR-148)', async () => {
    const validationRunId = await seedRun()
    const credential = await seedCredential(validationRunId)

    const report = await reportValidation(contextFor(credential), {
      phaseResults: [
        { phase: 'provisioning', outcome: 'succeeded', durationMs: 4 },
        { phase: 'bundle_download', outcome: 'succeeded' },
        { phase: 'setup_script', outcome: 'failed', detail: 'npm ci exited 1' },
      ],
      outputS3Key: 'validations/abc/def.txt',
    })

    expect(report.outcome).toBe('failed')
    expect(report.alreadyRecorded).toBe(false)
    expect(report.run?.outcome).toBe('failed')
    expect(report.run?.outputS3Key).toBe('validations/abc/def.txt')
    expect(report.run?.endedAt).toBeInstanceOf(Date)
    expect(report.run?.phaseResults).toStrictEqual({
      provisioning: { outcome: 'succeeded', durationMs: 4 },
      bundle_download: { outcome: 'succeeded' },
      setup_script: { outcome: 'failed', detail: 'npm ci exited 1' },
    })
  })

  it('retires the credential in the same transaction as the result', async () => {
    // A validation has exactly one thing to say. Leaving the token live afterwards would be a
    // credential with nothing left to authorise, sitting in user-data on a machine being torn down.
    const validationRunId = await seedRun()
    const credential = await seedCredential(validationRunId)

    await reportValidation(contextFor(credential), {
      phaseResults: [succeeded('provisioning')],
    })

    const [stored] = await fixtures
      .db()
      .select()
      .from(validationCredentials)
      .where(eq(validationCredentials.id, credential.credentialId))

    expect(stored.revokedAt).toBeInstanceOf(Date)
  })

  it('keeps the first report and answers a retry rather than refusing it (FR-047, FR-148)', async () => {
    // The executor retries when the surface is unreachable and cannot tell a lost response from a
    // failed write. A second report must not rewrite a verdict somebody has already read, and must
    // not throw either — an error would push a working instance into failing on its own success.
    const validationRunId = await seedRun()
    const credential = await seedCredential(validationRunId)

    await reportValidation(contextFor(credential), {
      phaseResults: [succeeded('provisioning'), succeeded('setup_script')],
    })

    const retry = await reportValidation(contextFor(credential), {
      phaseResults: [{ phase: 'setup_script', outcome: 'failed', detail: 'a later, wrong story' }],
    })

    expect(retry.alreadyRecorded).toBe(true)
    expect(retry.run).toBeNull()

    const [stored] = await fixtures
      .db()
      .select()
      .from(validationRuns)
      .where(eq(validationRuns.id, validationRunId))

    expect(stored.outcome).toBe('passed')
    expect(stored.phaseResults).toStrictEqual({
      provisioning: { outcome: 'succeeded' },
      setup_script: { outcome: 'succeeded' },
    })
  })

  it('refuses a credential naming a validation run that no longer exists', async () => {
    const validationRunId = await seedRun()
    const credential = await seedCredential(validationRunId)

    await expect(
      reportValidation(
        { ...contextFor(credential), validationRunId: randomUUID() },
        { phaseResults: [succeeded('provisioning')] },
      ),
    ).rejects.toThrow(/no longer exists/)
  })

  it('writes nothing about any other validation run', async () => {
    // The scoping property, in the only form it can take here: the run comes from the credential
    // and the payload has no field that could name another.
    const reported = await seedRun()
    const untouched = await seedRun()
    const credential = await seedCredential(reported)

    await reportValidation(contextFor(credential), {
      phaseResults: [succeeded('provisioning')],
    })

    const [other] = await fixtures
      .db()
      .select()
      .from(validationRuns)
      .where(eq(validationRuns.id, untouched))

    expect(other.outcome).toBeNull()
    expect(other.endedAt).toBeNull()
  })
})
