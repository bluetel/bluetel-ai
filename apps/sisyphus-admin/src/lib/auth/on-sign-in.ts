import { DEFAULT_USER_ROLE } from '@bluetel-ai/sisyphus-api/client'
import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { users } from '@bluetel-ai/sisyphus-api/db'
import { eq } from 'drizzle-orm'
import type { Adapter, AdapterUser } from 'next-auth/adapters'

import type { GoogleIdTokenClaims } from './permitted-domains'
import { describeDomainRejection, verifyPermittedDomain } from './permitted-domains'

/**
 * Auto-creation of a user on first successful sign-in, with the `engineer` role (FR-170).
 *
 * A member of a permitted Workspace domain signs in and can launch work immediately; there is no
 * invitation step, and no admin has to provision anybody. `engineer` — never `admin` — because
 * every route to `admin` is either an existing admin granting it or the deploy-time bootstrap
 * reconcile (FR-174), and a domain member is not by itself an administrator.
 *
 * ## Why this is an adapter override rather than a plain insert
 *
 * The stock Auth.js `createUser` cannot serve the `users` table: `google_subject` and
 * `display_name` are `not null` with no default, and Auth.js knows about neither. So
 * `createSisyphusAdapter({ db, createUser })` takes a replacement, and this module is it.
 *
 * ## Why the profile mapping is here too
 *
 * `createUser` is handed an `AdapterUser` — `{ id, name, email, image, emailVerified }` — and the
 * Google subject is **not** in it. Auth.js replaces the profile's id with a fresh UUID before
 * calling the adapter, keeping `sub` only on the account row it writes afterwards. The seam is
 * therefore two halves that have to agree: {@link mapGoogleProfile} is the provider's `profile()`
 * callback, which carries the verified claims through onto the object `createUser` receives, and
 * {@link createEngineerOnFirstSignIn} reads them back off it. Both live in this file so that the
 * agreement is visible in one place rather than split across the provider and the adapter.
 *
 * ## Where the domain check happens
 *
 * Auth.js runs the `signIn` callback — and therefore `verifyPermittedDomain`, via `decideSignIn` —
 * **before** it calls any adapter method, so creation is already downstream of the gate. This
 * module then re-runs `verifyPermittedDomain` against the claims it was handed, and refuses to
 * insert if they do not pass. That is deliberate duplication of a check, not of a rule: the same
 * function decides both times. What it buys is that a user row cannot be created by any future
 * wiring that reaches the adapter without the callback, which is the one mistake that would turn a
 * closed platform into an open one silently.
 */

/**
 * The ID token claims this seam reads. Extends the claims the domain check already knows about,
 * so there is one description of the payload rather than two.
 *
 * Typed as `unknown` per field for the same reason as `GoogleIdTokenClaims`: the payload arrives as
 * JSON, and asserting a shape it might not have is how an absent claim becomes an accidental pass.
 */
export interface GoogleSignInProfile extends GoogleIdTokenClaims {
  /** Google's stable subject identifier. Becomes `users.google_subject`. */
  readonly sub?: unknown
  readonly name?: unknown
  readonly picture?: unknown
}

/**
 * What {@link mapGoogleProfile} produces: Auth.js's `User` plus the four values the platform's own
 * columns need. Assignable to `User`, so it drops straight into the provider's `profile` option.
 */
export interface SisyphusOAuthUser {
  /** Kept as the Google subject: Auth.js stores it as `providerAccountId` on the account row. */
  readonly id: string
  readonly name: string | null
  readonly email: string
  readonly image: string | null
  /** `users.google_subject`. Stable across an email change, which is why it is stored at all. */
  readonly googleSubject: string
  /** `users.display_name` — the name a year of run history and notifications is attached to. */
  readonly displayName: string
  /** The verified `hd` claim, re-checked before the insert. */
  readonly hostedDomain: string | null
  /** Google's `email_verified`, re-checked before the insert. */
  readonly emailVerifiedByProvider: boolean
}

const asTrimmedString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const orNull = (value: string): string | null => (value === '' ? null : value)

/**
 * The Google provider's `profile()` callback.
 *
 * Identical to Auth.js's default mapping except that it carries `sub`, the name, the `hd` claim and
 * `email_verified` forward under names of the platform's own. Nothing is validated here — this runs
 * before the sign-in gate, and a mapping that threw would turn a sign-in that should be refused into a 500.
 *
 * @param profile - The verified ID token payload.
 */
export const mapGoogleProfile = (profile: GoogleSignInProfile): SisyphusOAuthUser => {
  const subject = asTrimmedString(profile.sub)
  const email = asTrimmedString(profile.email).toLowerCase()
  const name = asTrimmedString(profile.name)

  return {
    id: subject,
    name: orNull(name),
    email,
    image: orNull(asTrimmedString(profile.picture)),
    googleSubject: subject,
    // Falls back to the address so `display_name` is never blank: it is `not null`, and a user
    // rendered as an empty string in every list is worse than one rendered as their email.
    displayName: name === '' ? email : name,
    hostedDomain: orNull(asTrimmedString(profile.hd).toLowerCase()),
    emailVerifiedByProvider: profile.email_verified === true,
  }
}

/** The subset of {@link SisyphusOAuthUser} that survives onto the `AdapterUser`. */
type CarriedProfile = Pick<
  SisyphusOAuthUser,
  'googleSubject' | 'displayName' | 'hostedDomain' | 'emailVerifiedByProvider'
>

/**
 * Recover the carried claims from the object Auth.js passes to `createUser`.
 *
 * Returns `undefined` rather than guessing when they are absent, which happens only if the provider
 * is configured without {@link mapGoogleProfile}. The caller turns that into a loud failure: an
 * insert with an invented `google_subject` would create a user row that can never be matched to the
 * Google account it belongs to.
 */
export const readCarriedProfile = (user: AdapterUser): CarriedProfile | undefined => {
  const candidate = user as Partial<CarriedProfile>
  const googleSubject = asTrimmedString(candidate.googleSubject)
  const displayName = asTrimmedString(candidate.displayName)

  if (googleSubject === '' || displayName === '') {
    return undefined
  }

  return {
    googleSubject,
    displayName,
    hostedDomain: orNull(asTrimmedString(candidate.hostedDomain)),
    emailVerifiedByProvider: candidate.emailVerifiedByProvider === true,
  }
}

export interface FirstSignInOptions {
  readonly db: SisyphusDatabase
  /** From `SISYPHUS_PERMITTED_EMAIL_DOMAINS`, the same list the `signIn` callback checks. */
  readonly permittedDomains: readonly string[]
  /** Injected so a test can pin the recorded first sign-in time. Defaults to the wall clock. */
  readonly now?: () => Date
}

/**
 * The first row, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this project, so `rows[0]` is typed as present even when the
 * result set is empty — and a `=== undefined` guard against it is narrowed away as unreachable.
 * Going through a function whose *declared* return type admits `undefined` restores the check.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** Project a `users` row onto the shape Auth.js expects back from `createUser`. */
const toAdapterUser = (row: typeof users.$inferSelect): AdapterUser => ({
  id: row.id,
  email: row.email,
  emailVerified: row.emailVerified,
  name: row.name,
  image: row.image,
})

/**
 * Build the `createUser` override (FR-170).
 *
 * The returned `id` is the platform's own UUID v7 rather than the random UUID Auth.js proposed:
 * Auth.js uses whatever the adapter returns for the account link and the session, so the row's real
 * primary key is the one that ends up referenced — and every id in this schema is time-ordered,
 * which the pagination in `admin.users` depends on.
 */
export const createEngineerOnFirstSignIn =
  ({
    db,
    permittedDomains,
    now = () => new Date(),
  }: FirstSignInOptions): NonNullable<Adapter['createUser']> =>
  async (user) => {
    const carried = readCarriedProfile(user)
    if (carried === undefined) {
      throw new Error(
        'Cannot create a user: the Google provider is not configured with mapGoogleProfile, so the verified subject and display name never reached the adapter.',
      )
    }

    const verdict = verifyPermittedDomain(
      {
        hd: carried.hostedDomain,
        email: user.email,
        email_verified: carried.emailVerifiedByProvider,
      },
      permittedDomains,
    )
    if (!verdict.permitted) {
      // Reached only if something has been wired past the `signIn` callback. The message names the
      // reason and never the address, exactly as a refusal in the callback does.
      throw new Error(describeDomainRejection(verdict.reason))
    }

    const inserted = await db
      .insert(users)
      .values({
        email: user.email,
        googleSubject: carried.googleSubject,
        displayName: carried.displayName,
        // FR-170. Never `admin`: that comes from an existing admin or the bootstrap reconcile.
        role: DEFAULT_USER_ROLE,
        name: user.name ?? null,
        image: user.image ?? null,
        emailVerified: user.emailVerified,
        lastSignInAt: now(),
      })
      // A double-submitted sign-in would otherwise fail the second insert on the unique subject and
      // show the user an error for a request that had already succeeded. Idempotent on the IdP
      // identity rather than on the address, because the subject is what cannot change.
      .onConflictDoNothing({ target: users.googleSubject })
      .returning()

    const created = firstRow(inserted)
    if (created !== undefined) {
      return toAdapterUser(created)
    }

    const existing = await db
      .select()
      .from(users)
      .where(eq(users.googleSubject, carried.googleSubject))
      .limit(1)

    const row = firstRow(existing)
    if (row === undefined) {
      throw new Error('Creating the user reported a conflict, but no row with that subject exists.')
    }
    return toAdapterUser(row)
  }
