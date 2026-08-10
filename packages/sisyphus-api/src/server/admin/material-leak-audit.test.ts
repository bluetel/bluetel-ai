import { randomUUID } from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import {
  agentCredentials,
  credentialGroups,
  credentialLeases,
  workflowEvents,
  workflows,
} from '../../db'
import type { AuthorisationDenial, SisyphusContext, SisyphusSession } from '../context'
import type { MachineContext } from '../machine'
import { fetchAgentCredential, reportCredentialRotation } from '../machine'
import { createCallerFactory } from '../procedures'
import { memoiseScope } from '../scope'

import { credentialGroupsRouter } from './credential-groups'
import { credentialPoolRouter } from './credential-pool'
import { recordAgentCredentialLogin } from './credential-store'
import { credentialsRouter } from './credentials'
import { createUserFixtures, readTestDatabaseUrl } from './test-database'

/**
 * **The material-leak audit (003/T122, SC-014).**
 *
 * SC-014 is one sentence — *no credential material appears in any log, snapshot, job envelope,
 * bundle archive, or administrator-visible surface* — and it is the only requirement in this
 * feature that no single module can be made to satisfy. Every other requirement lives somewhere:
 * exclusivity is the partial unique index, attribution is the lease row, the envelope's silence is
 * `job-envelope.ts`. This one is a property of the whole platform, and a property of that kind is
 * satisfied by every component at once or not at all.
 *
 * ## Why this file exists beside the suites that already assert pieces of it
 *
 * Four suites already hold a corner of SC-014 down, and each is the right place for its corner:
 *
 * - `apps/sisyphus-control-plane/src/jobs/job-envelope.test.ts` — the envelope carries identifiers
 *   and a strict schema refuses anything else;
 * - `apps/sisyphus-executor/src/output/` — material is registered as a known value and the
 *   streaming redactor removes it from log segments, including across a buffer cut;
 * - `apps/sisyphus-executor/src/session/snapshot.test.ts` — the credential subtree is excluded at
 *   pack time rather than deleted afterwards;
 * - `./credentials.test.ts` — the four responses the **login flow** produces carry no material.
 *
 * What none of them can say is the cross-cutting thing: that after material has genuinely moved
 * through the platform — fetched by an instance, rotated by an agent mid-run — **it is in the
 * secret store and nowhere else at all**. Each of the suites above scans one output of one
 * component against one fixture. The failure this file is written for is the one that gets past all
 * of them: a well-meaning addition that copies material into a timeline detail, an audit row, a
 * failure reason, or a panel view that nobody thought of as a place material could reach, because
 * the module that wrote it was never about credentials.
 *
 * ## The two sweeps, and why the second one is the one that earns its place
 *
 * **The panel sweep** walks every administrator-visible response about a seat — the pool view, the
 * groups list and its references, the credential list and detail — to any depth, and asserts the
 * material is in none of them. `credentials.test.ts` does this for the login procedures; this does
 * it for the four surfaces it does not cover, which are the ones an administrator actually spends
 * their time on.
 *
 * **The database sweep** is the interesting one. It asks Postgres for every text, varchar and JSON
 * column in the schema and searches all of them, so it covers tables this file has never heard of
 * and tables that do not exist yet. A test that listed the columns it knew about would go stale the
 * first time somebody added one; this one gets wider on its own, and the day a migration adds a
 * column that a later change starts writing material into, this fails without anybody having
 * remembered to come back here.
 *
 * The material is real for the duration of the test: it is written through
 * `machine.reportCredentialRotation`, which is one of exactly two procedures in the platform that
 * ever hold material, and read back through `machine.fetchAgentCredential`, which is the other. So
 * both sweeps are asking a real question. A design in which the rotation path recorded what it
 * stored — the plausible, well-intentioned mistake — fails this file rather than passing it
 * quietly.
 *
 * ## What is deliberately **not** asserted here
 *
 * The user-data envelope, the log segment redactor and the snapshot exclusion are all asserted in
 * their own projects, against their own code, and restating them here would be a second copy that
 * could pass while the original failed. This file's job is the seam between them, not a summary of
 * them. The by-hand decode of a real instance's user data — the one check 003/T122 says is worth
 * not trusting a test with, because user data is readable from the metadata service by anything on
 * the box — is recorded in `specs/003-agent-credential-pool/quickstart.md`.
 */

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

/**
 * The material, and the rotation that replaces it.
 *
 * Distinctive strings on purpose. A sweep of every text column in the database will find plenty of
 * ids, names and timestamps, and a needle that could collide with one of those would produce either
 * a false failure or — far worse — a passing test whose search term never had a chance of matching.
 */
const INSTALLED_MATERIAL = 'sk-live-installed-4f2c9a-must-never-leave-the-secret-store'
const ROTATED_MATERIAL = 'sk-live-rotated-8b71de-must-never-leave-the-secret-store'

/** Every scalar reachable from a value, at any depth, including inside arrays and dates. */
const deepScalars = (value: unknown, seen = new Set<unknown>()): readonly string[] => {
  if (value === null || value === undefined) return []
  if (typeof value === 'string') return [value]
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)]
  if (value instanceof Date) return [value.toISOString()]
  if (typeof value !== 'object') return []
  if (seen.has(value)) return []
  seen.add(value)

  return Array.isArray(value)
    ? value.flatMap((entry) => deepScalars(entry, seen))
    : Object.values(value).flatMap((entry) => deepScalars(entry, seen))
}

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** One column somewhere in the schema that could hold a string. */
interface ScannableColumn {
  readonly table: string
  readonly column: string
}

/** Where a needle was found, so a failure names the row rather than merely the fact. */
interface Sighting {
  readonly table: string
  readonly column: string
  readonly needle: string
}

describeWithDatabase(
  'no credential material survives anywhere but the secret store (SC-014)',
  () => {
    const fixtures = createUserFixtures(connectionString ?? '')

    beforeAll(() => fixtures.open(), 60_000)
    afterAll(() => fixtures.close())

    const denials: AuthorisationDenial[] = []
    let admin = { id: '', email: '' }

    const named = (label: string): string => `${label}-${fixtures.suffix}`

    const contextFor = (): SisyphusContext => {
      const session: SisyphusSession = {
        user: {
          id: admin.id,
          email: admin.email,
          displayName: admin.email,
          role: 'admin',
          isActive: true,
        },
        expiresAt: new Date(Date.now() + 60_000),
      }

      return {
        headers: new Headers(),
        dependencies: {
          db: fixtures.db(),
          resolveSession: () => Promise.resolve(session),
          resolveMachineCredential: () => Promise.resolve(null),
          recordDenial: (denial) => {
            denials.push(denial)
            return Promise.resolve()
          },
        },
        db: fixtures.db(),
        session,
        scope: memoiseScope(() =>
          Promise.resolve({ userId: admin.id, isAdmin: true, visibleProfileIds: [] }),
        ),
        machineCredential: () => Promise.resolve(null),
        validationCredential: () => Promise.resolve(null),
      }
    }

    /**
     * The machine surface's context, exactly as `machineProcedure` assembles it.
     *
     * No field of the credential decides anything: both procedures resolve the seat from
     * `ctx.workflowId` alone, which is what makes it impossible for a caller to name somebody else's.
     */
    const machineContextFor = (workflowId: string): MachineContext => ({
      db: fixtures.db(),
      workflowId,
      credential: {
        credentialId: randomUUID(),
        workflowId,
        jti: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      },
      dependencies: contextFor().dependencies,
    })

    /**
     * The secret store, as a map.
     *
     * This *is* the place material is allowed to be, so the sweeps below assert against it in the
     * positive as well: a test that only checked for absence would pass just as happily against a
     * platform that had lost the material altogether.
     */
    const materials = new Map<string, string>()
    const store = {
      read: (secretId: string): Promise<string> => {
        const value = materials.get(secretId)
        if (value === undefined) {
          throw new Error(`No material stored under ${secretId}`)
        }
        return Promise.resolve(value)
      },
      write: (secretId: string, material: string): Promise<void> => {
        materials.set(secretId, material)
        return Promise.resolve()
      },
    }

    /** Every column in the schema whose type can hold a string, asked of Postgres rather than listed. */
    const scannableColumns = async (db: SisyphusDatabase): Promise<readonly ScannableColumn[]> => {
      const rows = (await db.execute(sql`
      select table_name as "table", column_name as "column"
      from information_schema.columns
      where table_schema = 'public'
        and data_type in ('text', 'character varying', 'character', 'json', 'jsonb')
      order by table_name, column_name
    `)) as unknown as readonly ScannableColumn[]

      return [...rows]
    }

    /**
     * Search every scannable column for every needle.
     *
     * One query per column rather than one enormous union, because the failure message is the point:
     * "material was found in `workflow_events.detail`" is actionable and "material was found
     * somewhere" is not. Every column is cast to `text` first, so a `jsonb` detail blob is searched
     * as the string an administrator would eventually read it as.
     */
    const sweepDatabase = async (needles: readonly string[]): Promise<readonly Sighting[]> => {
      const db = fixtures.db()
      const sightings: Sighting[] = []

      for (const { table, column } of await scannableColumns(db)) {
        for (const needle of needles) {
          const found = (await db.execute(sql`
          select 1 as "hit"
          from ${sql.identifier(table)}
          where position(${needle} in coalesce(${sql.identifier(column)}::text, '')) > 0
          limit 1
        `)) as unknown as readonly unknown[]

          if (firstRow([...found]) !== undefined) {
            sightings.push({ table, column, needle })
          }
        }
      }

      return sightings
    }

    const world = {
      credentialGroupId: '',
      credentialId: '',
      secretId: '',
      workflowId: '',
      fence: 0,
    }

    beforeAll(async () => {
      const seeded = await fixtures.seedUser({ label: 'material-audit-admin', role: 'admin' })
      admin = { id: seeded.id, email: seeded.email }

      const group = firstRow(
        await fixtures
          .db()
          .insert(credentialGroups)
          .values({ name: named('audit-group'), createdByUserId: admin.id })
          .returning({ id: credentialGroups.id }),
      )
      world.credentialGroupId = group?.id ?? ''

      // The identifier is the shape Secrets Manager hands back: a name plus the six-character suffix
      // it appends. It is not material and it does cross the panel — see the assertion below.
      world.secretId = `arn:aws:secretsmanager:eu-west-2:000000000000:secret:sisyphus/test/agent-credential/${named('audit')}-AbCdEf`

      const credential = firstRow(
        await fixtures
          .db()
          .insert(agentCredentials)
          .values({
            credentialGroupId: world.credentialGroupId,
            name: named('audit-seat'),
            // Registered and not yet logged in, which is the only state a login completes from:
            // `recordAgentCredentialLogin` is conditional on it, so seeding this as `available`
            // would make the capture below a silent no-op and leave the whole suite asserting
            // about a seat with no secret at all.
            state: 'awaiting_login',
            createdByUserId: admin.id,
          })
          .returning({ id: agentCredentials.id }),
      )
      world.credentialId = credential?.id ?? ''

      // The login, as the capture records it: the identifier reaches the database and the material
      // reaches the store, and the two never travel together.
      await recordAgentCredentialLogin(fixtures.db(), world.credentialId, {
        secretId: world.secretId,
        lastLoginAt: new Date(),
      })
      materials.set(world.secretId, INSTALLED_MATERIAL)

      // A run holding the seat, so both machine procedures have something to resolve.
      world.workflowId = await fixtures.seedWorkflow({ ownerUserId: admin.id, state: 'running' })

      const claimed = firstRow(
        await fixtures
          .db()
          .update(agentCredentials)
          .set({
            state: 'held',
            heldBy: 'workflow',
            fence: sql`${agentCredentials.fence} + 1`,
            lastUsedAt: new Date(),
          })
          .where(eq(agentCredentials.id, world.credentialId))
          .returning({ fence: agentCredentials.fence }),
      )
      world.fence = claimed?.fence ?? 0

      await fixtures.db().insert(credentialLeases).values({
        agentCredentialId: world.credentialId,
        workflowId: world.workflowId,
        fence: world.fence,
      })

      await fixtures
        .db()
        .update(workflows)
        .set({ agentCredentialId: world.credentialId })
        .where(eq(workflows.id, world.workflowId))
    }, 60_000)

    it('moves real material through both machine procedures, so the sweeps ask a real question', async () => {
      // The install half: an instance in bootstrap phase `credential_install` fetching the seat it
      // was leased. This is the only way material leaves the store, and it leaves it to exactly one
      // caller, over a request that was authorised by a workflow-scoped credential.
      const fetched = await fetchAgentCredential(machineContextFor(world.workflowId), store)

      expect(fetched.material).toBe(INSTALLED_MATERIAL)
      expect(fetched.credentialId).toBe(world.credentialId)

      // The rotation half: the agent refreshed its own login mid-run and the executor reported the
      // new bytes. This is the only way material enters the platform outside a login capture.
      const rotated = await reportCredentialRotation(
        machineContextFor(world.workflowId),
        { fence: world.fence, material: ROTATED_MATERIAL },
        store,
      )

      expect(rotated).toStrictEqual({ accepted: true })
      expect(materials.get(world.secretId)).toBe(ROTATED_MATERIAL)
    })

    it('leaves no trace of either material in any column of any table (SC-014)', async () => {
      // The sweep that gets wider on its own. Postgres is asked which columns could hold a string,
      // so a table added by a future migration is covered the day it exists rather than the day
      // somebody remembers this file.
      const sightings = await sweepDatabase([INSTALLED_MATERIAL, ROTATED_MATERIAL])

      expect(
        sightings,
        sightings.length === 0
          ? ''
          : `credential material reached the database: ${sightings
              .map((sighting) => `${sighting.table}.${sighting.column}`)
              .join(', ')}`,
      ).toStrictEqual([])
    })

    it('scans a schema wide enough for the claim to mean something', async () => {
      // A guard on the guard. If `scannableColumns` ever returned nothing — a changed schema name, a
      // renamed information_schema view — the sweep above would pass by scanning nothing at all, and
      // would go on passing for ever. The exact number is nobody's business; that it covers the
      // tables this feature writes to is.
      const columns = await scannableColumns(fixtures.db())
      const tables = new Set(columns.map((column) => column.table))

      expect(columns.length).toBeGreaterThan(50)
      // `credential_leases` is deliberately absent from this list and its absence from the scan is
      // correct: every column on it is a uuid, an integer or a timestamp, so there is nothing on
      // that table a string could be written into. The tables below all carry free text or a JSON
      // detail blob, which is where a leak would actually land.
      for (const table of [
        'agent_credentials',
        'workflows',
        'workflow_events',
        'configuration_audit',
      ]) {
        expect(tables).toContain(table)
      }
    })

    it('would catch a leak, planted and then removed', async () => {
      // The negative control, and the reason the sweep above is worth anything. A search that
      // matched nothing because it was searching wrongly — a cast that silently produced null, a
      // `position` against the wrong column, an empty column list — would pass the clean sweep
      // for ever and report a guarantee it had never checked.
      //
      // `workflow_events.detail` is the column chosen deliberately: it is a `jsonb` blob written
      // by half the jobs in the control plane and rendered to engineers in the workflow view, so
      // it is both the most plausible place for a leak to land and the case a naive text search
      // would miss.
      await fixtures
        .db()
        .insert(workflowEvents)
        .values({
          workflowId: world.workflowId,
          event: 'corrected',
          actorType: 'control_plane',
          detail: { plantedByTheAudit: ROTATED_MATERIAL },
        })

      const planted = await sweepDatabase([ROTATED_MATERIAL])

      expect(planted).toContainEqual({
        table: 'workflow_events',
        column: 'detail',
        needle: ROTATED_MATERIAL,
      })

      await fixtures
        .db()
        .delete(workflowEvents)
        .where(
          and(
            eq(workflowEvents.workflowId, world.workflowId),
            sql`${workflowEvents.detail}->>'plantedByTheAudit' is not null`,
          ),
        )

      // And the sweep is clean again, so the planted row cannot leave the rest of the file
      // failing for a reason that has nothing to do with the platform.
      expect(await sweepDatabase([INSTALLED_MATERIAL, ROTATED_MATERIAL])).toStrictEqual([])
    })

    it('finds the material only where it is supposed to be', async () => {
      // The positive half. Absence everywhere is trivially satisfiable by a platform that stored
      // nothing, and a suite that could not tell those two apart would be reporting on itself.
      expect(materials.get(world.secretId)).toBe(ROTATED_MATERIAL)
      expect(await store.read(world.secretId)).toBe(ROTATED_MATERIAL)
    })

    it('keeps material out of every administrator-visible response about a seat', async () => {
      // The four surfaces `credentials.test.ts` does not walk: the pool view an administrator watches
      // capacity on, the groups screen, and the seat list and detail. Walked to the bottom, because
      // the mistake worth catching is a nested object that happens to carry material rather than a
      // top-level field nobody would add.
      const context = contextFor()
      const pool = createCallerFactory(credentialPoolRouter)(context)
      const groups = createCallerFactory(credentialGroupsRouter)(context)
      const credentials = createCallerFactory(credentialsRouter)(context)

      const responses: readonly unknown[] = [
        await pool.view({}),
        await groups.list({}),
        await groups.references({ credentialGroupId: world.credentialGroupId }),
        await credentials.list({ credentialGroupId: world.credentialGroupId, limit: 100 }),
        await credentials.get({ agentCredentialId: world.credentialId }),
      ]

      for (const response of responses) {
        const scalars = deepScalars(response)

        for (const needle of [INSTALLED_MATERIAL, ROTATED_MATERIAL]) {
          expect(scalars).not.toContain(needle)
          expect(
            scalars.some((value) => value.includes(needle)),
            'an administrator-visible response carried credential material',
          ).toBe(false)
        }
      }
    })

    it('does show the identifier, because a name is not material', async () => {
      // Stated so the assertion above is not mistaken for "nothing about the secret crosses". The
      // pool view names where a seat's material lives precisely so an administrator can find it in
      // the console without guessing; what it never carries is the thing behind the name.
      const detail = await createCallerFactory(credentialsRouter)(contextFor()).get({
        agentCredentialId: world.credentialId,
      })

      expect(deepScalars(detail)).toContain(world.secretId)
    })
  },
)
