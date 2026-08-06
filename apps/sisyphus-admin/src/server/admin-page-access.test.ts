import type { SisyphusSessionUser } from '@sisyphus-admin/lib/auth'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Imported through a stubbed environment rather than with the auth barrel mocked, so the decision
 * is exercised against the **real** `isAdminSessionUser`. Mocking the guard would leave the one
 * thing this module is for — that a non-admin cannot reach an admin page — asserted against a
 * stand-in.
 */
const environment: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgres://sisyphus@db.invalid:5432/sisyphus',
  AUTH_SECRET: 'auth-secret',
  AUTH_GOOGLE_ID: 'google-client-id',
  AUTH_GOOGLE_SECRET: 'google-client-secret',
  SISYPHUS_PERMITTED_EMAIL_DOMAINS: 'bluetel.co.uk',
  SISYPHUS_MACHINE_CREDENTIAL_SECRET: 'machine-secret',
  SISYPHUS_LOGS_BUCKET: 'logs',
  SISYPHUS_BUNDLES_BUCKET: 'bundles',
  SISYPHUS_ARTIFACTS_BUCKET: 'artifacts',
  SISYPHUS_STAGE: 'test',
  NEXT_PUBLIC_NODE_ENV: 'test',
  NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com',
}

const importModule = async () => {
  vi.resetModules()
  vi.stubEnv('SKIP_ENV_VALIDATION', '')
  vi.stubEnv('AUTH_URL', 'https://sisyphus.example.com')
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
  return import('./admin-page-access')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

const user = (overrides: Partial<SisyphusSessionUser> = {}): SisyphusSessionUser => ({
  id: '0199a1f4-0000-7000-8000-000000000005',
  email: 'admin@bluetel.co.uk',
  displayName: 'An Admin',
  role: 'admin',
  isActive: true,
  ...overrides,
})

describe('decideAdminPageAccess', () => {
  it('renders for an active admin, and hands the page the caller', async () => {
    const { decideAdminPageAccess } = await importModule()
    const caller = user()

    expect(decideAdminPageAccess(caller)).toStrictEqual({ kind: 'render', user: caller })
  })

  it('sends a caller with no session to sign in rather than answering 404', async () => {
    const { decideAdminPageAccess } = await importModule()

    expect(decideAdminPageAccess(undefined)).toStrictEqual({ kind: 'sign-in' })
  })

  it('answers not-found for an engineer, never a refusal that confirms the page exists', async () => {
    const { decideAdminPageAccess } = await importModule()

    expect(decideAdminPageAccess(user({ role: 'engineer' }))).toStrictEqual({ kind: 'not-found' })
  })

  it('answers not-found for a deactivated admin rather than inviting them to sign in again', async () => {
    const { decideAdminPageAccess } = await importModule()

    expect(decideAdminPageAccess(user({ isActive: false }))).toStrictEqual({ kind: 'not-found' })
  })

  it('answers not-found for a deactivated engineer', async () => {
    const { decideAdminPageAccess } = await importModule()

    expect(decideAdminPageAccess(user({ role: 'engineer', isActive: false }))).toStrictEqual({
      kind: 'not-found',
    })
  })

  it('never produces a forbidden outcome, because there is no such outcome to produce', async () => {
    const { decideAdminPageAccess } = await importModule()
    const outcomes = [undefined, user(), user({ role: 'engineer' }), user({ isActive: false })].map(
      (candidate) => decideAdminPageAccess(candidate).kind,
    )

    expect(outcomes).not.toContain('forbidden')
  })

  it('points at the sign-in page Auth.js is configured with', async () => {
    const { SIGN_IN_PATH } = await importModule()

    expect(SIGN_IN_PATH).toBe('/sign-in')
  })
})
