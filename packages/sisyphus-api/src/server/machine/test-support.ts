import { randomUUID } from 'node:crypto'

import { scopedCredentials } from '../../db'
import type { AuthorisationDenial, MachineCredential, SisyphusDependencies } from '../context'
import type { TwoProfileFixture } from '../workflow/test-support'
import { createTwoProfileFixture, readTestDatabaseUrl, refusalOf } from '../workflow/test-support'

import type { MachineContext } from './guard'

/**
 * **Test support for the machine-surface live suites.** Not production code, and deliberately not
 * re-exported from `./index.ts`.
 *
 * It wraps the two-profile fixture rather than seeding its own world, for one reason: the property
 * every procedure on this surface has to hold is that a credential for workflow **A** cannot write
 * anything about workflow **B**, and that fixture is already exactly two workflows with two
 * owners, two profiles and an entry each. A second fixture would be a second, subtly different
 * definition of "another workflow" — and there is one database harness in this package.
 *
 * On top of it this adds the two things the machine surface needs and the interactive surface does
 * not: a `scoped_credentials` row per run, and a context whose `recordDenial` keeps what it was
 * given, so a test can assert the **security event** was recorded and not merely that the write
 * was refused (FR-018, SC-014).
 */

export { readTestDatabaseUrl, refusalOf }
export type { TwoProfileFixture }

/**
 * The first row, honestly typed. `noUncheckedIndexedAccess` is off in this project, so `rows[0]`
 * is typed as present even when the result set is empty.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** A context plus the denials recorded through it. */
export interface RecordingMachineContext {
  readonly ctx: MachineContext
  /** Every denial `assertMachineWorkflowMatches` recorded, in order. */
  readonly denials: readonly AuthorisationDenial[]
}

export interface MachineFixture extends TwoProfileFixture {
  /**
   * Insert a live credential for one run and return it as the middleware would have resolved it.
   *
   * One live credential per workflow is a partial unique index (`scoped_credentials_live_key`), so
   * calling this twice for the same run is a conflict rather than a second credential — which is
   * the constraint, not a limitation of the fixture.
   */
  readonly seedCredential: (workflowId: string) => Promise<MachineCredential>
  /** Build a resolver context pinned to one credential, recording every denial it produces. */
  readonly contextFor: (credential: MachineCredential) => RecordingMachineContext
}

/** How long a seeded credential is valid for. Comfortably past any test's runtime. */
const CREDENTIAL_LIFETIME_MS = 60 * 60 * 1000

/**
 * Build the machine fixture.
 *
 * @param connectionString - From {@link readTestDatabaseUrl}; the caller has already skipped when
 *   it is `undefined`.
 */
export const createMachineFixture = (connectionString: string): MachineFixture => {
  const base = createTwoProfileFixture(connectionString)

  return {
    ...base,

    seedCredential: async (workflowId) => {
      const jti = randomUUID()
      const expiresAt = new Date(Date.now() + CREDENTIAL_LIFETIME_MS)

      const rows = await base
        .db()
        .insert(scopedCredentials)
        .values({ workflowId, jti, expiresAt })
        .returning({ id: scopedCredentials.id })

      const credentialId = firstRow(rows)?.id
      if (credentialId === undefined) {
        throw new Error('Seeding a scoped credential returned no row.')
      }

      return { credentialId, workflowId, jti, expiresAt }
    },

    contextFor: (credential) => {
      const denials: AuthorisationDenial[] = []
      const db = base.db()

      const dependencies: SisyphusDependencies = {
        db,
        // The machine surface refuses a request carrying a human session, so this always answers
        // `null` — a fixture that returned one would be testing `surface_confusion`, not scoping.
        resolveSession: () => Promise.resolve(null),
        resolveMachineCredential: () => Promise.resolve(credential),
        recordDenial: (denial) => {
          denials.push(denial)
          return Promise.resolve()
        },
      }

      return {
        ctx: { db, workflowId: credential.workflowId, credential, dependencies },
        denials,
      }
    },
  }
}
