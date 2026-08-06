import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ExecutionProfileVersion } from '../../db'
import { profileOverrides } from '../../db'
import { createUserFixtures, readTestDatabaseUrl } from '../admin/test-database'
import { memoiseScope } from '../scope'

import { lockedFieldError, OVERRIDABLE_FIELDS, resolveLaunchPlan } from './launch-plan'
import {
  assertOverridesPermitted,
  describeOverridableFields,
  lockedOverrideFields,
  lockedOverridesError,
  readProfileOverrides,
  readProfileOverridesInScope,
} from './overrides'

const profileVersion = (
  overrides: Partial<ExecutionProfileVersion> = {},
): ExecutionProfileVersion => ({
  id: 'profile-version',
  executionProfileId: 'profile',
  version: 3,
  workspaceVersionId: 'workspace-version',
  setupBundleVersionId: 'bundle-version',
  model: 'claude-sonnet-5',
  instanceType: 'm7i.large',
  purchaseMode: 'on_demand',
  turnCap: 40,
  spendCap: '25.0000',
  defaultWorkflowType: 'delegated',
  promptPreamble: null,
  lockedFields: [],
  createdByUserId: 'admin',
  createdAt: new Date(),
  ...overrides,
})

describe('describeOverridableFields', () => {
  it('describes every overridable field, so the form shows what the run will use (FR-122)', () => {
    expect(describeOverridableFields(profileVersion())).toStrictEqual([
      { field: 'model', profileValue: 'claude-sonnet-5', locked: false },
      { field: 'instanceType', profileValue: 'm7i.large', locked: false },
      { field: 'purchaseMode', profileValue: 'on_demand', locked: false },
      { field: 'turnCap', profileValue: '40', locked: false },
      { field: 'spendCap', profileValue: '25.0000', locked: false },
      { field: 'workflowType', profileValue: 'delegated', locked: false },
    ])
  })

  it('covers exactly the fields the launch plan can apply', () => {
    // A field the form could not describe would be one the run uses and the operator never saw.
    expect(describeOverridableFields(profileVersion()).map((item) => item.field)).toStrictEqual([
      ...OVERRIDABLE_FIELDS,
    ])
  })

  it('marks a locked field locked, so the form renders it as locked rather than offering it', () => {
    const described = describeOverridableFields(
      profileVersion({ lockedFields: ['model', 'spendCap'] }),
    )

    expect(described.filter((item) => item.locked).map((item) => item.field)).toStrictEqual([
      'model',
      'spendCap',
    ])
  })

  it('reports a cap the profile does not set as null rather than as a number', () => {
    const described = describeOverridableFields(profileVersion({ turnCap: null, spendCap: null }))

    expect(described.find((item) => item.field === 'turnCap')?.profileValue).toBeNull()
    expect(described.find((item) => item.field === 'spendCap')?.profileValue).toBeNull()
  })
})

describe('lockedOverrideFields', () => {
  it('finds nothing when the caller overrode nothing (FR-122)', () => {
    expect(
      lockedOverrideFields(profileVersion({ lockedFields: ['model'] }), undefined),
    ).toStrictEqual([])
    expect(lockedOverrideFields(profileVersion({ lockedFields: ['model'] }), {})).toStrictEqual([])
  })

  it('finds a locked field the caller tried to change', () => {
    expect(
      lockedOverrideFields(profileVersion({ lockedFields: ['model'] }), {
        model: 'claude-opus-5',
      }),
    ).toStrictEqual(['model'])
  })

  it('ignores an unlocked field, however many are overridden', () => {
    expect(
      lockedOverrideFields(profileVersion({ lockedFields: ['model'] }), {
        instanceType: 'm7i.4xlarge',
        turnCap: 80,
      }),
    ).toStrictEqual([])
  })

  it('does not refuse the profile’s own value resubmitted by the prefilled form (FR-122)', () => {
    // The launch form prefills every value, so it submits the profile's own numbers far more often
    // than it submits changes. Refusing those would make a locked profile impossible
    // to launch from its own form.
    expect(
      lockedOverrideFields(profileVersion({ lockedFields: ['model', 'spendCap'] }), {
        model: 'claude-sonnet-5',
        spendCap: '25.0000',
      }),
    ).toStrictEqual([])
  })

  it('returns every locked field the submission touched, in a stable order', () => {
    expect(
      lockedOverrideFields(profileVersion({ lockedFields: ['spendCap', 'model', 'turnCap'] }), {
        spendCap: '100.0000',
        model: 'claude-opus-5',
        turnCap: 80,
      }),
    ).toStrictEqual(['model', 'turnCap', 'spendCap'])
  })
})

describe('assertOverridesPermitted', () => {
  it('permits an override of a field the profile does not lock (FR-123)', () => {
    expect(() =>
      assertOverridesPermitted(profileVersion(), { instanceType: 'm7i.4xlarge' }),
    ).not.toThrow()
  })

  it('refuses a locked field rather than silently ignoring it, and names it (FR-123)', () => {
    // The failure this requirement is about: the operator believes they changed the model, they did
    // not, and nothing told them. A refusal that named no field would be barely better — the form
    // has six controls on it.
    expect(() =>
      assertOverridesPermitted(profileVersion({ lockedFields: ['model'] }), {
        model: 'claude-opus-5',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'BAD_REQUEST',
        message: 'The execution profile locks model, so it cannot be overridden for a single run.',
      }),
    )
  })

  it('names every locked field at once, not one refusal per round trip', () => {
    expect(() =>
      assertOverridesPermitted(profileVersion({ lockedFields: ['model', 'spendCap'] }), {
        model: 'claude-opus-5',
        spendCap: '100.0000',
      }),
    ).toThrow(
      expect.objectContaining({
        message:
          'The execution profile locks model, spendCap, so they cannot be overridden for a single run.',
      }),
    )
  })

  it('reads `lockedFields` off the pinned version, not off a later one (FR-125)', () => {
    // A lock added after this run was configured must not retroactively refuse it: the run pins the
    // version it was launched against.
    expect(() =>
      assertOverridesPermitted(profileVersion({ lockedFields: [] }), { model: 'claude-opus-5' }),
    ).not.toThrow()
  })
})

describe('lockedOverridesError', () => {
  it('says exactly what `resolveLaunchPlan` says for a single field', () => {
    // Two wordings of one rule would drift. This is the assertion that stops them.
    expect(lockedOverridesError(['model']).message).toBe(lockedFieldError('model').message)
  })

  it('agrees with the refusal the launch path raises for the same submission', () => {
    const version = profileVersion({ lockedFields: ['spendCap'] })
    const attempted = { spendCap: '100.0000' }

    let fromPlan = ''
    try {
      resolveLaunchPlan(version, attempted)
    } catch (error) {
      fromPlan = error instanceof Error ? error.message : ''
    }

    let fromAssertion = ''
    try {
      assertOverridesPermitted(version, attempted)
    } catch (error) {
      fromAssertion = error instanceof Error ? error.message : ''
    }

    expect(fromAssertion).toBe(fromPlan)
    expect(fromAssertion).toContain('spendCap')
  })

  it('is BAD_REQUEST — the caller holds the profile, the request is what is wrong', () => {
    expect(lockedOverridesError(['model', 'turnCap']).code).toBe('BAD_REQUEST')
  })
})

const liveDatabaseUrl = readTestDatabaseUrl()

/**
 * The record half of FR-123 against a real Postgres. Skipped — not failed — without
 * `SISYPHUS_TEST_DATABASE_URL`.
 */
describe.skipIf(liveDatabaseUrl === undefined)('reading recorded overrides', () => {
  const fixtures = createUserFixtures(liveDatabaseUrl ?? '')

  let ownerId = ''
  let outsiderId = ''
  let workflowId = ''

  const scopeFor = (userId: string) => ({
    userId,
    isAdmin: false,
    visibleProfileIds: [] as readonly string[],
  })

  beforeAll(async () => {
    await fixtures.open()
    const owner = await fixtures.seedUser({ label: 'override-owner' })
    const outsider = await fixtures.seedUser({ label: 'override-outsider' })
    ownerId = owner.id
    outsiderId = outsider.id

    workflowId = await fixtures.seedWorkflow({ ownerUserId: ownerId, state: 'running' })

    await fixtures
      .db()
      .insert(profileOverrides)
      .values([
        {
          workflowId,
          field: 'instanceType',
          profileValue: 'm7i.large',
          usedValue: 'm7i.4xlarge',
          setByUserId: ownerId,
        },
        {
          workflowId,
          field: 'turnCap',
          profileValue: null,
          usedValue: '80',
          setByUserId: ownerId,
        },
      ])
  }, 60_000)

  afterAll(async () => {
    await fixtures.close()
  }, 30_000)

  it('keeps both values, so the run’s configuration is explicable (FR-123)', async () => {
    const recorded = await readProfileOverrides(fixtures.db(), workflowId)

    expect(recorded).toHaveLength(2)
    expect(recorded[0]).toMatchObject({
      field: 'instanceType',
      profileValue: 'm7i.large',
      usedValue: 'm7i.4xlarge',
      setByUserId: ownerId,
    })
    // A cap the profile never set is recorded as null, not as an invented figure.
    expect(recorded[1]).toMatchObject({ field: 'turnCap', profileValue: null, usedValue: '80' })
  })

  it('reports nothing for a run that deviated from nothing', async () => {
    const untouched = await fixtures.seedWorkflow({ ownerUserId: ownerId, state: 'running' })
    await expect(readProfileOverrides(fixtures.db(), untouched)).resolves.toStrictEqual([])
  })

  it('answers the owner, whose ownership alone makes the run visible (FR-189)', async () => {
    await expect(
      readProfileOverridesInScope({
        db: fixtures.db(),
        scope: scopeFor(ownerId),
        workflowId,
      }),
    ).resolves.toHaveLength(2)
  })

  it('reports an out-of-scope run as NOT_FOUND, not as an empty list (FR-190)', async () => {
    // An empty list is an answer. "That run changed nothing" about a run whose existence the caller
    // was not entitled to learn is the disclosure FR-190 prohibits.
    await expect(
      readProfileOverridesInScope({
        db: fixtures.db(),
        scope: scopeFor(outsiderId),
        workflowId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Workflow not found.' })
  })

  it('reports a workflow that does not exist the same way', async () => {
    await expect(
      readProfileOverridesInScope({
        db: fixtures.db(),
        scope: scopeFor(ownerId),
        workflowId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('resolves the scope through the shared resolver the procedures use', async () => {
    const resolver = memoiseScope(() => Promise.resolve(scopeFor(ownerId)))

    await expect(
      readProfileOverridesInScope({
        db: fixtures.db(),
        scope: await resolver.resolve(),
        workflowId,
      }),
    ).resolves.toHaveLength(2)
  })
})
