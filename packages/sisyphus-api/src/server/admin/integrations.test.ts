import { TRPCError } from '@trpc/server'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import {
  configurationAudit,
  executionProfiles,
  executionProfileVersions,
  integrations,
  setupBundles,
  setupBundleVersions,
  ticketClaims,
  workflows,
  workspaces,
  workspaceVersions,
} from '../../db'
import type { UserRole } from '../../enums'
import type { AuthorisationDenial, SisyphusContext, SisyphusSession } from '../context'
import { createCallerFactory } from '../procedures'
import { memoiseScope } from '../scope'

import { CONNECTOR_NOT_CONFIGURED_REASON } from './integration-connectors'
import {
  createFakeConnectorRegistry,
  createFakeIntegrationConnector,
  createFakePromptLayering,
} from './integration-connectors-fake'
import {
  createIntegrationsRouter,
  duplicateIntegrationNameError,
  enableRefusals,
  integrationsRouter,
  integrationTargetNotFoundError,
  MANUAL_TICK_CHANNEL,
} from './integrations'
import { createUserFixtures, readTestDatabaseUrl } from './test-database'

const refusalOf = async (attempt: Promise<unknown>): Promise<TRPCError> => {
  try {
    await attempt
  } catch (error) {
    if (error instanceof TRPCError) {
      return error
    }
    throw error
  }

  throw new Error('Expected the call to be refused, but it succeeded.')
}

interface CallerIdentity {
  readonly id: string
  readonly email: string
  readonly role: UserRole
}

const contextFor = (
  db: SisyphusDatabase,
  user: CallerIdentity,
  denials: AuthorisationDenial[],
): SisyphusContext => {
  const session: SisyphusSession = {
    user: { ...user, displayName: user.email, isActive: true },
    expiresAt: new Date(Date.now() + 60_000),
  }

  return {
    headers: new Headers(),
    dependencies: {
      db,
      resolveSession: () => Promise.resolve(session),
      resolveMachineCredential: () => Promise.resolve(null),
      recordDenial: (denial) => {
        denials.push(denial)
        return Promise.resolve()
      },
    },
    db,
    session,
    scope: memoiseScope(() =>
      Promise.resolve({ userId: user.id, isAdmin: user.role === 'admin', visibleProfileIds: [] }),
    ),
    machineCredential: () => Promise.resolve(null),
  }
}

describe('the admin.integrations contract', () => {
  it('exposes exactly the procedures api-surface.md names', () => {
    expect(Object.keys(integrationsRouter._def.procedures).sort()).toStrictEqual([
      'create',
      'delete',
      'list',
      'previewPrompt',
      'references',
      'runNow',
      'runs',
      'setEnabled',
      'update',
      'validate',
    ])
  })

  it('makes the reads queries and every write a mutation', () => {
    const procedures = integrationsRouter._def.procedures

    expect(procedures.list._def.type).toBe('query')
    expect(procedures.runs._def.type).toBe('query')
    expect(procedures.references._def.type).toBe('query')
    expect(procedures.previewPrompt._def.type).toBe('query')
    for (const name of [
      'create',
      'update',
      'setEnabled',
      'delete',
      'runNow',
      'validate',
    ] as const) {
      expect(procedures[name]._def.type).toBe('mutation')
    }
  })

  it('refuses an unknown target with NOT_FOUND, never FORBIDDEN (FR-190)', () => {
    expect(integrationTargetNotFoundError().code).toBe('NOT_FOUND')
    expect(integrationTargetNotFoundError().message).toBe(
      'No such integration, execution profile or user.',
    )
  })

  it('echoes only the caller-supplied name on a duplicate', () => {
    expect(duplicateIntegrationNameError('payments board').code).toBe('CONFLICT')
  })
})

describe('enableRefusals (FR-130, FR-133, FR-158)', () => {
  const base = {
    defaultOwnerUserId: 'user-1',
    promptIntro: 'Work from this board ships as one pull request.',
  }

  it('passes a complete integration', () => {
    expect(enableRefusals(base as never, 1)).toEqual([])
  })

  it('refuses one with no default owner', () => {
    expect(enableRefusals({ ...base, defaultOwnerUserId: null } as never, 1)[0]).toContain(
      'nobody accountable',
    )
  })

  it('refuses one with a blank prompt intro', () => {
    expect(enableRefusals({ ...base, promptIntro: '   ' } as never, 1)[0]).toContain(
      'nobody described',
    )
  })

  it('refuses one with no mappings, which would be a scheduled no-op', () => {
    expect(enableRefusals(base as never, 0)[0]).toContain('every ticket it found would be skipped')
  })

  it('names every failing element at once, rather than one per attempt', () => {
    expect(enableRefusals({ defaultOwnerUserId: null, promptIntro: '' } as never, 0)).toHaveLength(
      3,
    )
  })
})

const liveDatabaseUrl = readTestDatabaseUrl()

describe.skipIf(liveDatabaseUrl === undefined)(
  'admin.integrations against a live database (T119)',
  () => {
    const fixtures = createUserFixtures(liveDatabaseUrl ?? '')
    const denials: AuthorisationDenial[] = []

    let admin: CallerIdentity
    let engineer: CallerIdentity
    let executionProfileId = ''

    const connector = createFakeIntegrationConnector({
      items: [
        {
          externalId: 'FIX-1',
          title: 'Checkout totals are wrong',
          url: 'https://boards.invalid/browse/FIX-1',
          body: 'The basket adds VAT twice.',
          assigneeEmail: null,
          comments: [
            {
              id: '1',
              authorIdentity: 'sisyphus',
              isPlatformAuthored: true,
              body: 'Sisyphus has picked this up.',
              createdAt: new Date(0),
            },
            {
              id: '2',
              authorIdentity: 'human',
              isPlatformAuthored: false,
              body: 'Still reproducing.',
              createdAt: new Date(0),
            },
          ],
          attributes: {},
        },
      ],
    })
    const registry = createFakeConnectorRegistry(connector)
    const promptLayering = createFakePromptLayering()
    const createCaller = createCallerFactory(
      createIntegrationsRouter({ connectors: registry, promptLayering }),
    )
    const emptyRegistry = createFakeConnectorRegistry()
    const createRefusingCaller = createCallerFactory(
      createIntegrationsRouter({ connectors: emptyRegistry, promptLayering }),
    )

    const asAdmin = () => createCaller(contextFor(fixtures.db(), admin, denials))
    const asEngineer = () => createCaller(contextFor(fixtures.db(), engineer, denials))

    let created = 0

    const settings = (overrides: Record<string, unknown> = {}) => {
      created += 1
      return {
        name: `board-${fixtures.suffix}-${String(created)}`,
        baseUrl: 'https://boards.invalid',
        credentialSecretArn: `arn:fixture:secret:${fixtures.suffix}`,
        projectPrefix: 'FIX',
        label: 'sisyphus',
        extraFilters: null,
        defaultOwnerUserId: admin.id,
        promptIntro: 'Work from this board ships as one pull request.',
        cronExpression: '0/15 * * * *',
        timezone: 'Europe/London',
        perTickCeiling: 3,
        rollingPeriodCeiling: 12,
        rollingPeriodMinutes: 60,
        mappings: [{ position: 0, criteria: {}, executionProfileId, isDefault: true }],
        ...overrides,
      }
    }

    const createIntegration = async (overrides: Record<string, unknown> = {}) =>
      asAdmin().create({ type: 'jira', ...settings(overrides) } as never)

    const auditFor = async (integrationId: string) =>
      fixtures
        .db()
        .select()
        .from(configurationAudit)
        .where(
          and(
            eq(configurationAudit.entityType, 'integration'),
            eq(configurationAudit.entityId, integrationId),
          ),
        )

    beforeAll(async () => {
      await fixtures.open()

      const adminUser = await fixtures.seedUser({ label: 'admin', role: 'admin' })
      const engineerUser = await fixtures.seedUser({ label: 'engineer', role: 'engineer' })
      admin = { id: adminUser.id, email: adminUser.email, role: 'admin' }
      engineer = { id: engineerUser.id, email: engineerUser.email, role: 'engineer' }

      const [bundle] = await fixtures
        .db()
        .insert(setupBundles)
        .values({ name: `bundle-${fixtures.suffix}`, enabled: true, createdByUserId: admin.id })
        .returning({ id: setupBundles.id })
      const [bundleVersion] = await fixtures
        .db()
        .insert(setupBundleVersions)
        .values({
          setupBundleId: bundle.id,
          version: 1,
          s3Key: `fixtures/${fixtures.suffix}.tar.gz`,
          contentDigest: 'a'.repeat(64),
          sizeBytes: 1,
          registeredByUserId: admin.id,
        })
        .returning({ id: setupBundleVersions.id })
      const [workspace] = await fixtures
        .db()
        .insert(workspaces)
        .values({ name: `workspace-${fixtures.suffix}` })
        .returning({ id: workspaces.id })
      const [workspaceVersion] = await fixtures
        .db()
        .insert(workspaceVersions)
        .values({ workspaceId: workspace.id, version: 1, createdByUserId: admin.id })
        .returning({ id: workspaceVersions.id })
      const [profile] = await fixtures
        .db()
        .insert(executionProfiles)
        .values({ name: `profile-${fixtures.suffix}`, enabled: true })
        .returning({ id: executionProfiles.id })
      const [version] = await fixtures
        .db()
        .insert(executionProfileVersions)
        .values({
          executionProfileId: profile.id,
          version: 1,
          workspaceVersionId: workspaceVersion.id,
          setupBundleVersionId: bundleVersion.id,
          model: 'claude-sonnet-5',
          instanceType: 'm7i.large',
          purchaseMode: 'spot',
          defaultWorkflowType: 'delegated',
          promptPreamble: 'The contract lives in packages/contracts.',
          createdByUserId: admin.id,
        })
        .returning({ id: executionProfileVersions.id })
      await fixtures
        .db()
        .update(executionProfiles)
        .set({ currentVersionId: version.id })
        .where(eq(executionProfiles.id, profile.id))

      executionProfileId = profile.id
    }, 120_000)

    afterAll(async () => {
      await fixtures.close()
    })

    describe('admin-only (FR-186)', () => {
      it('refuses an engineer even the list', async () => {
        expect((await refusalOf(asEngineer().list({ enabledOnly: false, limit: 10 }))).code).toBe(
          'FORBIDDEN',
        )
      })

      it('records the refusal', async () => {
        denials.length = 0
        await refusalOf(asEngineer().list({ enabledOnly: false, limit: 10 }))
        expect(denials[0]?.reason).toBe('not_admin')
      })
    })

    describe('the credential is write-only (FR-098)', () => {
      it('is not on the row a create returns', async () => {
        const listing = await createIntegration()

        expect(JSON.stringify(listing)).not.toContain('arn:fixture:secret')
        expect('credentialSecretArn' in listing).toBe(false)
      })

      it('is not on any row the list returns', async () => {
        await createIntegration()
        const page = await asAdmin().list({ enabledOnly: false, limit: 50 })

        expect(JSON.stringify(page)).not.toContain('arn:fixture:secret')
      })

      it('is stored, so the connector can still be built from it', async () => {
        const listing = await createIntegration()
        const [row] = await fixtures
          .db()
          .select({ arn: integrations.credentialSecretArn })
          .from(integrations)
          .where(eq(integrations.id, listing.id))

        expect(row.arn).toContain('arn:fixture:secret')
      })

      it('never reaches the audit trail (FR-178)', async () => {
        const listing = await createIntegration()

        expect(JSON.stringify(await auditFor(listing.id))).not.toContain('arn:fixture:secret')
      })

      it('never reaches the connector config, only the factory that builds the client', async () => {
        const listing = await createIntegration()
        await asAdmin().validate({ integrationId: listing.id })

        const request = registry.requests[registry.requests.length - 1]
        expect(JSON.stringify(request.config)).not.toContain('arn:fixture:secret')
        expect(request.credentialSecretArn).toContain('arn:fixture:secret')
      })
    })

    describe('create', () => {
      it('creates disabled, whatever the caller wanted', async () => {
        expect((await createIntegration()).enabled).toBe(false)
      })

      it('stores the mappings in position order', async () => {
        const listing = await createIntegration({
          mappings: [
            { position: 1, criteria: { issueType: 'Story' }, executionProfileId, isDefault: false },
            { position: 0, criteria: { issueType: 'Bug' }, executionProfileId, isDefault: false },
          ],
        })

        expect(listing.mappings.map((mapping) => mapping.position)).toEqual([0, 1])
      })

      it('names the resolved profile on each mapping, so an admin can read the rules', async () => {
        const listing = await createIntegration()

        expect(listing.mappings[0].executionProfileName).toContain('profile-')
      })

      it('refuses a duplicate name', async () => {
        const listing = await createIntegration()

        expect((await refusalOf(createIntegration({ name: listing.name }))).code).toBe('CONFLICT')
      })

      it('writes the trail with the acting admin (FR-178)', async () => {
        const listing = await createIntegration()
        const [entry] = await auditFor(listing.id)

        expect(entry.action).toBe('registered')
        expect(entry.actorUserId).toBe(admin.id)
      })
    })

    describe('update', () => {
      it('replaces the mappings wholesale', async () => {
        const listing = await createIntegration()
        const updated = await asAdmin().update({
          integrationId: listing.id,
          ...settings({ name: listing.name }),
          mappings: [
            { position: 0, criteria: { issueType: 'Bug' }, executionProfileId, isDefault: false },
          ],
        } as never)

        expect(updated.mappings).toHaveLength(1)
        expect(updated.mappings[0].criteria).toEqual({ issueType: 'Bug' })
      })

      it('refuses a change that would leave an enabled integration unable to run', async () => {
        const listing = await createIntegration()
        await asAdmin().setEnabled({ integrationId: listing.id, enabled: true })

        const refusal = await refusalOf(
          asAdmin().update({
            integrationId: listing.id,
            ...settings({ name: listing.name }),
            mappings: [],
          } as never),
        )

        expect(refusal.code).toBe('CONFLICT')
        expect(refusal.message).toContain('every ticket it found would be skipped')
      })

      it('refuses an unknown integration with NOT_FOUND', async () => {
        expect(
          (
            await refusalOf(
              asAdmin().update({
                integrationId: '11111111-1111-4111-8111-111111111111',
                ...settings(),
              } as never),
            )
          ).code,
        ).toBe('NOT_FOUND')
      })
    })

    describe('setEnabled', () => {
      it('enables a complete integration', async () => {
        const listing = await createIntegration()

        expect(
          (await asAdmin().setEnabled({ integrationId: listing.id, enabled: true })).enabled,
        ).toBe(true)
      })

      it('refuses one with no default owner (FR-133)', async () => {
        const listing = await createIntegration({ defaultOwnerUserId: null })

        expect(
          (await refusalOf(asAdmin().setEnabled({ integrationId: listing.id, enabled: true })))
            .message,
        ).toContain('nobody accountable')
      })

      it('refuses one with no mappings (FR-130)', async () => {
        const listing = await createIntegration({ mappings: [] })

        expect(
          (await refusalOf(asAdmin().setEnabled({ integrationId: listing.id, enabled: true })))
            .message,
        ).toContain('every ticket it found would be skipped')
      })

      it('clears the auto-disable reason and the failure count when a human re-enables it', async () => {
        const listing = await createIntegration()
        await fixtures
          .db()
          .update(integrations)
          .set({ consecutiveFailures: 5, autoDisabledReason: 'auto-disabled after 5 failed ticks' })
          .where(eq(integrations.id, listing.id))

        const enabled = await asAdmin().setEnabled({ integrationId: listing.id, enabled: true })

        expect(enabled.autoDisabledReason).toBeNull()
        expect(enabled.consecutiveFailures).toBe(0)
      })

      it('never gates disabling', async () => {
        const listing = await createIntegration({ mappings: [] })

        expect(
          (await asAdmin().setEnabled({ integrationId: listing.id, enabled: false })).enabled,
        ).toBe(false)
      })

      it('writes no trail entry for a no-op', async () => {
        const listing = await createIntegration()
        await asAdmin().setEnabled({ integrationId: listing.id, enabled: false })

        expect(await auditFor(listing.id)).toHaveLength(1)
      })
    })

    describe('delete and references', () => {
      it('deletes an integration that has never started anything', async () => {
        const listing = await createIntegration()

        expect(await asAdmin().delete({ integrationId: listing.id })).toEqual({
          deleted: true,
          integrationId: listing.id,
        })
        expect(await refusalOf(asAdmin().references({ integrationId: listing.id }))).toBeInstanceOf(
          TRPCError,
        )
      })

      it('refuses to delete one whose runs would become unexplainable', async () => {
        const listing = await createIntegration()
        await fixtures
          .db()
          .insert(ticketClaims)
          .values({ integrationId: listing.id, externalId: 'FIX-9' })

        const refusal = await refusalOf(asAdmin().delete({ integrationId: listing.id }))

        expect(refusal.code).toBe('CONFLICT')
        expect(refusal.message).toContain('Disable it instead')
      })

      it('reports what references it', async () => {
        const listing = await createIntegration()
        await fixtures
          .db()
          .insert(ticketClaims)
          .values({ integrationId: listing.id, externalId: 'FIX-8' })

        expect(await asAdmin().references({ integrationId: listing.id })).toMatchObject({
          claimedTicketCount: 1,
          deletable: false,
        })
      })
    })

    describe('validate (FR-097)', () => {
      it('reports the connector verdict rather than throwing on an unreachable board', async () => {
        const listing = await createIntegration()

        expect(await asAdmin().validate({ integrationId: listing.id })).toMatchObject({
          integrationId: listing.id,
          ok: true,
        })
      })

      it('says so when the deployment has registered no connector for that type', async () => {
        const listing = await createIntegration()
        const refusal = await refusalOf(
          createRefusingCaller(contextFor(fixtures.db(), admin, denials)).validate({
            integrationId: listing.id,
          }),
        )

        expect(refusal.message).toBe(CONNECTOR_NOT_CONFIGURED_REASON)
      })
    })

    describe('runNow (FR-035, FR-097)', () => {
      it('signals the control plane rather than ticking here', async () => {
        const listing = await createIntegration()
        await asAdmin().setEnabled({ integrationId: listing.id, enabled: true })

        expect(await asAdmin().runNow({ integrationId: listing.id })).toEqual({
          integrationId: listing.id,
          requested: true,
          channel: MANUAL_TICK_CHANNEL,
        })
      })

      it('starts nothing itself — the panel holds no permission to provision', async () => {
        const listing = await createIntegration()
        await asAdmin().setEnabled({ integrationId: listing.id, enabled: true })
        await asAdmin().runNow({ integrationId: listing.id })

        const rows = await fixtures
          .db()
          .select()
          .from(workflows)
          .where(eq(workflows.originatingIntegrationId, listing.id))

        expect(rows).toHaveLength(0)
      })

      it('refuses to run a disabled integration', async () => {
        const listing = await createIntegration()

        expect((await refusalOf(asAdmin().runNow({ integrationId: listing.id }))).code).toBe(
          'CONFLICT',
        )
      })

      it('names the auto-disable reason when there is one (FR-106)', async () => {
        const listing = await createIntegration()
        await fixtures
          .db()
          .update(integrations)
          .set({ autoDisabledReason: 'auto-disabled after 5 consecutive failed ticks: timeout' })
          .where(eq(integrations.id, listing.id))

        expect(
          (await refusalOf(asAdmin().runNow({ integrationId: listing.id }))).message,
        ).toContain('consecutive failed ticks')
      })
    })

    describe('previewPrompt (FR-160)', () => {
      it('renders every layer, through the same assembler the tick uses', async () => {
        const listing = await createIntegration()

        const preview = await asAdmin().previewPrompt({
          integrationId: listing.id,
          externalId: 'FIX-1',
        })

        expect(preview.prompt).toContain('The contract lives in packages/contracts.')
        expect(preview.prompt).toContain('Work from this board ships as one pull request.')
        expect(preview.prompt).toContain('Checkout totals are wrong')
        expect(preview.resolvedProfileId).toBe(executionProfileId)
      })

      it('hands the assembler the ticket layers with platform comments already excluded (FR-161)', async () => {
        const listing = await createIntegration()
        await asAdmin().previewPrompt({ integrationId: listing.id, externalId: 'FIX-1' })

        const layered = promptLayering.inputs[promptLayering.inputs.length - 1]
        expect(layered.parts.comments).toEqual(['Still reproducing.'])
      })

      it('reports an unresolved sample as unmatched rather than guessing a profile (FR-130)', async () => {
        const listing = await createIntegration({
          mappings: [
            { position: 0, criteria: { issueType: 'Bug' }, executionProfileId, isDefault: false },
          ],
        })

        const preview = await asAdmin().previewPrompt({
          integrationId: listing.id,
          externalId: 'FIX-1',
        })

        expect(preview.resolvedProfileId).toBeUndefined()
        expect(preview.resolutionReason).toBe('no_mapping_matched')
      })

      it('will not act as a ticket-existence oracle for the board', async () => {
        const listing = await createIntegration()
        const refusal = await refusalOf(
          asAdmin().previewPrompt({ integrationId: listing.id, externalId: 'FIX-404' }),
        )

        expect(refusal.code).toBe('NOT_FOUND')
        expect(refusal.message).toContain('not among the items this integration currently matches')
      })
    })

    describe('runs (FR-105)', () => {
      it('refuses an unknown integration with NOT_FOUND rather than an empty page', async () => {
        expect(
          (
            await refusalOf(
              asAdmin().runs({
                integrationId: '11111111-1111-4111-8111-111111111111',
                limit: 10,
              }),
            )
          ).code,
        ).toBe('NOT_FOUND')
      })

      it('returns an empty page for an integration that has never ticked', async () => {
        const listing = await createIntegration()

        expect(await asAdmin().runs({ integrationId: listing.id, limit: 10 })).toEqual({
          items: [],
          nextCursor: undefined,
        })
      })
    })
  },
)
