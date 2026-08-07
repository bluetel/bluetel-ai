import { randomUUID } from 'node:crypto'

import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { createDatabaseClient, users } from '@bluetel-ai/sisyphus-api/db'
import { inArray } from 'drizzle-orm'
import type { AdapterUser } from 'next-auth/adapters'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createSignInCallback } from './callbacks'
import { createEngineerOnFirstSignIn, mapGoogleProfile, readCarriedProfile } from './on-sign-in'

const PERMITTED = ['bluetel.co.uk']

/** A pool that is never connected. Any test using it asserts that the database is *not* reached. */
const unreachableDatabase = (): SisyphusDatabase =>
  createDatabaseClient({
    connectionString: 'postgres://sisyphus@db.invalid:5432/sisyphus',
    connectTimeoutSeconds: 1,
  }).db

/** The object Auth.js hands to `createUser`: the profile mapping, plus its own id and email. */
const adapterUserFrom = (profile: object, overrides: Partial<AdapterUser> = {}): AdapterUser =>
  ({
    ...profile,
    id: randomUUID(),
    emailVerified: null,
    ...overrides,
  }) as AdapterUser

const googleProfile = {
  sub: '110000000000000000001',
  name: 'Alice Engineer',
  email: 'Alice@Bluetel.co.uk',
  email_verified: true,
  hd: 'bluetel.co.uk',
  picture: 'https://example.invalid/alice.png',
}

describe('mapGoogleProfile', () => {
  it('carries the subject and the display name through to the adapter', () => {
    // Auth.js replaces the profile id with a random UUID before calling `createUser`, so anything
    // the platform's own columns need has to travel under a name of its own or it is simply lost.
    expect(mapGoogleProfile(googleProfile)).toMatchObject({
      googleSubject: '110000000000000000001',
      displayName: 'Alice Engineer',
      hostedDomain: 'bluetel.co.uk',
      emailVerifiedByProvider: true,
    })
  })

  it('keeps the subject as the id, which is what the account row is keyed on', () => {
    expect(mapGoogleProfile(googleProfile).id).toBe('110000000000000000001')
  })

  it('lower-cases the address, because an address is one address (R13)', () => {
    expect(mapGoogleProfile(googleProfile).email).toBe('alice@bluetel.co.uk')
  })

  it('falls back to the address when Google returns no name', () => {
    // `display_name` is `not null`, and a user rendered as an empty string in every admin list is
    // worse than one rendered as their email.
    expect(mapGoogleProfile({ ...googleProfile, name: '  ' }).displayName).toBe(
      'alice@bluetel.co.uk',
    )
  })

  it('does not decide anything about the claims it carries', () => {
    // This runs before the sign-in gate. A mapping that threw on a bad claim would turn a sign-in
    // that should be *refused* into a server error.
    expect(() => mapGoogleProfile({})).not.toThrow()
    expect(mapGoogleProfile({ hd: 'evil.example', email_verified: false })).toMatchObject({
      hostedDomain: 'evil.example',
      emailVerifiedByProvider: false,
    })
  })
})

describe('readCarriedProfile', () => {
  it('recovers what the mapping carried', () => {
    expect(readCarriedProfile(adapterUserFrom(mapGoogleProfile(googleProfile)))).toMatchObject({
      googleSubject: '110000000000000000001',
      displayName: 'Alice Engineer',
    })
  })

  it('reports absence rather than inventing a subject', () => {
    // A row inserted with a made-up `google_subject` could never be matched to the Google account
    // it belongs to, and nothing would ever notice.
    expect(
      readCarriedProfile({
        id: randomUUID(),
        email: 'alice@bluetel.co.uk',
        emailVerified: null,
      }),
    ).toBeUndefined()
  })
})

describe('createEngineerOnFirstSignIn refusals', () => {
  it('refuses when the provider was not wired with the profile mapping', async () => {
    const createUser = createEngineerOnFirstSignIn({
      db: unreachableDatabase(),
      permittedDomains: PERMITTED,
    })

    await expect(
      createUser({ id: randomUUID(), email: 'alice@bluetel.co.uk', emailVerified: null }),
    ).rejects.toThrow(/mapGoogleProfile/)
  })

  it('refuses a domain that is not permitted, even reached directly (FR-011)', async () => {
    const createUser = createEngineerOnFirstSignIn({
      db: unreachableDatabase(),
      permittedDomains: PERMITTED,
    })

    await expect(
      createUser(
        adapterUserFrom(mapGoogleProfile({ ...googleProfile, hd: 'attacker.example' }), {
          email: 'alice@attacker.example',
        }),
      ),
    ).rejects.toThrow(/SISYPHUS_PERMITTED_EMAIL_DOMAINS/)
  })

  it('refuses an account Google has not verified', async () => {
    const createUser = createEngineerOnFirstSignIn({
      db: unreachableDatabase(),
      permittedDomains: PERMITTED,
    })

    await expect(
      createUser(adapterUserFrom(mapGoogleProfile({ ...googleProfile, email_verified: false }))),
    ).rejects.toThrow(/unverified/)
  })

  it('never runs when the sign-in gate has already refused', async () => {
    // Auth.js calls `signIn` before it calls any adapter method. This test pins that ordering from
    // the platform's side: the gate says no, and nothing downstream of it creates a row.
    const createUser = vi.fn()
    const signIn = createSignInCallback({
      permittedDomains: PERMITTED,
      findExistingUser: () => Promise.resolve(undefined),
      warn: () => undefined,
    })

    const allowed = await signIn({
      profile: { ...googleProfile, hd: 'attacker.example' },
    })

    expect(allowed).toBe(false)
    expect(createUser).not.toHaveBeenCalled()
  })
})

const connectionString = process.env.SISYPHUS_TEST_DATABASE_URL?.trim()
const describeWithDatabase =
  connectionString === undefined || connectionString === '' ? describe.skip : describe

describeWithDatabase('createEngineerOnFirstSignIn against a live database', () => {
  const suffix = randomUUID().slice(0, 8)
  let client: ReturnType<typeof createDatabaseClient>
  const created: string[] = []

  const profileFor = (label: string) => ({
    ...googleProfile,
    sub: `${suffix}-${label}`,
    email: `${suffix}-${label}@bluetel.co.uk`,
  })

  beforeAll(() => {
    client = createDatabaseClient({ connectionString: connectionString ?? '' })
  })

  afterAll(async () => {
    if (created.length > 0) {
      await client.db.delete(users).where(inArray(users.id, created))
    }
    await client.close()
  })

  const create = async (label: string, at?: Date): Promise<AdapterUser> => {
    const createUser = createEngineerOnFirstSignIn({
      db: client.db,
      permittedDomains: PERMITTED,
      ...(at === undefined ? {} : { now: () => at }),
    })
    const mapped = mapGoogleProfile(profileFor(label))
    const user = await createUser(adapterUserFrom(mapped, { email: mapped.email }))
    created.push(user.id)
    return user
  }

  it('creates the user as an engineer, with no invitation step (FR-170)', async () => {
    const signedInAt = new Date('2026-03-01T09:00:00.000Z')
    const user = await create('new-joiner', signedInAt)

    const rows = await client.db
      .select()
      .from(users)
      .where(inArray(users.id, [user.id]))
    expect(rows[0]).toMatchObject({
      email: `${suffix}-new-joiner@bluetel.co.uk`,
      googleSubject: `${suffix}-new-joiner`,
      displayName: 'Alice Engineer',
      role: 'engineer',
      isActive: true,
      lastSignInAt: signedInAt,
    })
  })

  it("returns the platform's own id, not the one Auth.js proposed", async () => {
    // Auth.js links the account and creates the session against whatever `createUser` returns, so
    // returning the row's real key is what stops the session pointing at a user that does not exist.
    const user = await create('own-id')
    const rows = await client.db
      .select()
      .from(users)
      .where(inArray(users.id, [user.id]))
    expect(rows).toHaveLength(1)
    // UUID v7: the version nibble is what the keyset pagination in `admin.users` relies on.
    expect(user.id[14]).toBe('7')
  })

  it('is idempotent on the Google subject, so a double-submitted sign-in is not an error', async () => {
    const first = await create('double-click')
    const second = await create('double-click')

    expect(second.id).toBe(first.id)
    const rows = await client.db
      .select()
      .from(users)
      .where(inArray(users.id, [first.id]))
    expect(rows).toHaveLength(1)
  })

  it('creates nobody as an admin', async () => {
    // Every route to `admin` is an existing admin granting it or the bootstrap reconcile (FR-174).
    // Domain membership is not one of them.
    const user = await create('not-an-admin')
    const rows = await client.db
      .select()
      .from(users)
      .where(inArray(users.id, [user.id]))
    expect(rows[0]?.role).not.toBe('admin')
  })
})
