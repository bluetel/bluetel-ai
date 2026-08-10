import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  credentialRotationRejection,
  fetchAgentCredentialInput,
  fetchAgentCredentialOutput,
  reportCredentialRotationInput,
} from '../../contracts'
import { agentCredentials, credentialGroups, credentialLeases, workflows } from '../../db'
import type { MachineCredential, SisyphusContext } from '../context'
import { createCallerFactory } from '../procedures'

import { fetchAgentCredential, reportCredentialRotation } from './agent-credential'
import type { AgentCredentialMaterialStore } from './credential-material'
import { MATERIAL_STORE_NOT_CONFIGURED_REASON } from './credential-material'
import { machineSurfaceRouter } from './router'
import type { MachineFixture } from './test-support'
import { createMachineFixture, readTestDatabaseUrl } from './test-support'

/**
 * **The machine surface's two credential calls (T039, FR-012, FR-020, FR-032, SC-014).**
 *
 * The contract these settle is not "the happy path works". It is two properties that would each be
 * a serious defect to lose, and both are asserted as properties rather than as examples.
 *
 * ## Property one — a caller cannot ask for another run's seat, and there is nowhere to try
 *
 * Asserting "workflow A got A's material" would pass just as well against a resolver that read a
 * `credentialId` out of the payload, because no honest caller sends one. So this suite attacks it
 * from three directions instead:
 *
 * 1. **The input schema has no field at all**, and every selector an attacker might reach for is
 *    enumerated and refused — by the schema, and again through the mounted procedure, where the
 *    refusal lands before any query runs.
 * 2. **The answer is a function of the credential alone.** The same call, made against two
 *    contexts, returns two different seats; nothing a caller supplies participates.
 * 3. **The one field that looks like it might select — `fence` — is proved not to be.** Presenting
 *    the *other* credential's fence from this run's context writes to this run's secret. A wrong
 *    fence is a rejection or an acceptance; it is never a redirection.
 *
 * ## Property two — a post-terminal rotation on a current fence is accepted (FR-032)
 *
 * The one most likely to be got wrong, because the obvious implementation gets it wrong: by the
 * time a rotation lands after its run has ended, FR-019 has already released the lease, so a
 * rotation path that resolved the seat through the live lease would reject exactly the case the
 * requirement is about. The suite therefore does not merely terminate the workflow — it **deletes
 * the lease rows outright** before rotating, so any future "tidy-up" that reintroduced a lease
 * lookup or a run-state check fails here immediately rather than shipping a stranded seat.
 */

const connectionString = readTestDatabaseUrl()

/**
 * Every field name a caller might reach for to name somebody else's seat.
 *
 * Enumerated rather than exemplified, because the guarantee is about the whole of the input space:
 * a schema that refused `credentialId` while stripping `agent_credential_id` would satisfy a single
 * example and none of the property.
 */
const SEAT_SELECTORS = [
  'credentialId',
  'agentCredentialId',
  'agent_credential_id',
  'workflowId',
  'workflow_id',
  'leaseId',
  'secretId',
  'secret_id',
  'name',
] as const

/** An in-memory secret store, and a record of everything asked of it. */
interface RecordingMaterialStore extends AgentCredentialMaterialStore {
  readonly seed: (secretId: string, material: string) => void
  readonly stored: (secretId: string) => string | undefined
  readonly reads: readonly string[]
  readonly writes: readonly string[]
}

const createRecordingMaterialStore = (): RecordingMaterialStore => {
  const values = new Map<string, string>()
  const reads: string[] = []
  const writes: string[] = []

  return {
    reads,
    writes,
    seed: (secretId, material) => {
      values.set(secretId, material)
    },
    stored: (secretId) => values.get(secretId),
    read: (secretId) => {
      reads.push(secretId)
      const value = values.get(secretId)
      return value === undefined
        ? Promise.reject(new Error(`no secret named ${secretId}`))
        : Promise.resolve(value)
    },
    write: (secretId, material) => {
      writes.push(secretId)
      values.set(secretId, material)
      return Promise.resolve()
    },
  }
}

describe('the shapes these two procedures accept', () => {
  it('gives fetchAgentCredential no parameter at all — property one, stated as a schema', () => {
    expect(Object.keys(fetchAgentCredentialInput.shape)).toStrictEqual([])
    expect(fetchAgentCredentialInput.parse({})).toStrictEqual({})
  })

  it('refuses every seat selector rather than stripping it', () => {
    for (const key of SEAT_SELECTORS) {
      // Zod's default is to strip, which would parse successfully, empty the payload and answer
      // 200 — the guarantee would hold and nobody would ever find out something had tried.
      expect(fetchAgentCredentialInput.safeParse({ [key]: randomUUID() }).success).toBe(false)
      expect(
        reportCredentialRotationInput.safeParse({
          fence: 1,
          material: 'rotated',
          [key]: randomUUID(),
        }).success,
      ).toBe(false)
    }
  })

  it('lets a rotation name only a fence and a payload — neither of which selects anything', () => {
    expect(Object.keys(reportCredentialRotationInput.shape).sort()).toStrictEqual([
      'fence',
      'material',
    ])
  })

  it('answers rejections in the contract’s own closed vocabulary', () => {
    // The executor branches on these two words: one means "you have lost the seat, wind down", the
    // other means "nothing to do, carry on". A third spelling would make them indistinguishable.
    expect(credentialRotationRejection.options).toStrictEqual(['stale_fence', 'not_newer'])
  })
})

describe('the mounted procedures, before any database is reached', () => {
  /** Any property access throws, so a refusal that ran a query surfaces as that error instead. */
  const unreachableDatabase = new Proxy(
    {},
    {
      get: () => {
        throw new Error('an invalid credential request must be refused before any query')
      },
    },
  ) as SisyphusContext['db']

  const callerWith = (credential: MachineCredential | null) => {
    const context: SisyphusContext = {
      headers: new Headers(),
      dependencies: {
        db: unreachableDatabase,
        resolveSession: () => Promise.resolve(null),
        resolveMachineCredential: () => Promise.resolve(credential),
        recordDenial: () => Promise.resolve(),
      },
      db: unreachableDatabase,
      session: null,
      scope: { resolve: () => Promise.reject(new Error('the machine surface has no scope')) },
      machineCredential: () => Promise.resolve(credential),
    }

    return createCallerFactory(machineSurfaceRouter)(context)
  }

  const liveCredential = (): MachineCredential => ({
    credentialId: randomUUID(),
    workflowId: randomUUID(),
    jti: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000),
  })

  it('refuses both without a scoped credential (T053, FR-005)', async () => {
    const caller = callerWith(null)

    await expect(caller.fetchAgentCredential({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(
      caller.reportCredentialRotation({ fence: 1, material: 'rotated' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('refuses an authorised caller that tries to name a seat — property one, at the mount', async () => {
    const caller = callerWith(liveCredential())

    for (const key of SEAT_SELECTORS) {
      await expect(
        caller.fetchAgentCredential({ [key]: randomUUID() } as Record<string, never>),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    }
  })
})

describe.skipIf(connectionString === undefined)(
  'the credential machine surface, against Postgres',
  () => {
    let fixture: MachineFixture
    /** The credential covering run A — the caller in almost every assertion below. */
    let asRunA: MachineCredential
    /** The credential covering run B, whose seat run A must never be able to reach. */
    let asRunB: MachineCredential

    const seatA = { id: '', secretId: 'sisyphus/agent/seat-a', material: 'material-of-seat-a' }
    const seatB = { id: '', secretId: 'sisyphus/agent/seat-b', material: 'material-of-seat-b' }

    let materials: RecordingMaterialStore

    const contextFor = (credential: MachineCredential) => fixture.contextFor(credential).ctx

    const fenceOf = async (agentCredentialId: string): Promise<number> => {
      const rows = await fixture
        .db()
        .select({ fence: agentCredentials.fence })
        .from(agentCredentials)
        .where(eq(agentCredentials.id, agentCredentialId))

      return rows[0].fence
    }

    const setFence = async (agentCredentialId: string, fence: number): Promise<void> => {
      await fixture
        .db()
        .update(agentCredentials)
        .set({ fence })
        .where(eq(agentCredentials.id, agentCredentialId))
    }

    beforeAll(async () => {
      materials = createRecordingMaterialStore()
      materials.seed(seatA.secretId, seatA.material)
      materials.seed(seatB.secretId, seatB.material)

      fixture = createMachineFixture(connectionString ?? '')
      await fixture.open()

      const ids = fixture.ids()
      asRunA = await fixture.seedCredential(ids.a.workflowId)
      asRunB = await fixture.seedCredential(ids.b.workflowId)

      const [group] = await fixture
        .db()
        .insert(credentialGroups)
        .values({ name: 'seats', createdByUserId: ids.admin })
        .returning({ id: credentialGroups.id })

      // Two seats, leased one each, exactly as an acquisition would leave them: a `held` credential,
      // a live lease row, and the run's `agent_credential_id` recorded (FR-059). Written directly
      // rather than through the allocator, which lives in the control plane — what matters here is
      // the shape an acquisition leaves behind, and that shape is fixed by data-model.md.
      for (const [seat, workflowId, name] of [
        [seatA, ids.a.workflowId, 'seat-a'],
        [seatB, ids.b.workflowId, 'seat-b'],
      ] as const) {
        const [credential] = await fixture
          .db()
          .insert(agentCredentials)
          .values({
            credentialGroupId: group.id,
            name,
            state: 'held',
            heldBy: 'workflow',
            secretId: seat.secretId,
            fence: 1,
            createdByUserId: ids.admin,
          })
          .returning({ id: agentCredentials.id })

        seat.id = credential.id

        await fixture
          .db()
          .insert(credentialLeases)
          .values({ agentCredentialId: credential.id, workflowId, fence: 1 })

        await fixture
          .db()
          .update(workflows)
          .set({ agentCredentialId: credential.id })
          .where(eq(workflows.id, workflowId))
      }
    }, 60_000)

    afterAll(async () => {
      await fixture.close()
    }, 30_000)

    describe('fetchAgentCredential', () => {
      it('hands back the material of the seat the caller’s live lease names (FR-012)', async () => {
        await expect(fetchAgentCredential(contextFor(asRunA), materials)).resolves.toStrictEqual({
          credentialId: seatA.id,
          fence: 1,
          material: seatA.material,
        })
      })

      it('answers a shape carrying identifiers and material and nothing else', async () => {
        const answer = await fetchAgentCredential(contextFor(asRunA), materials)

        // `.strict()`, so a resolver that grew an extra field — a secret id, a lease id, a workflow
        // id — fails here rather than quietly widening what an instance is told.
        expect(fetchAgentCredentialOutput.parse(answer)).toStrictEqual(answer)
      })

      it('is a function of the credential alone — the same call answers two different seats', async () => {
        // Property one from the other side. Nothing the caller supplies differs between these two
        // calls, because there is nothing the caller supplies at all; only the scoped credential
        // does, and the answer follows it.
        const forA = await fetchAgentCredential(contextFor(asRunA), materials)
        const forB = await fetchAgentCredential(contextFor(asRunB), materials)

        expect(forA.credentialId).toBe(seatA.id)
        expect(forB.credentialId).toBe(seatB.id)
        expect(forA.material).not.toBe(forB.material)
      })

      it('never reads the other run’s secret while serving this one', async () => {
        const before = materials.reads.length
        await fetchAgentCredential(contextFor(asRunA), materials)

        expect(materials.reads.slice(before)).toStrictEqual([seatA.secretId])
      })

      it('refuses when the deployment wired no material store, rather than installing nothing', async () => {
        // The resolver's default: an unwired deployment refuses both directions. An empty read here
        // would install a working credential's worth of nothing on a paid instance.
        await expect(fetchAgentCredential(contextFor(asRunA))).rejects.toMatchObject({
          code: 'INTERNAL_SERVER_ERROR',
        })
      })

      it('names the identifier and never the material when the store fails', async () => {
        const empty = createRecordingMaterialStore()

        await expect(fetchAgentCredential(contextFor(asRunA), empty)).rejects.toMatchObject({
          message: expect.not.stringContaining(seatA.material) as unknown as string,
        })
      })
    })

    describe('reportCredentialRotation', () => {
      it('writes the rotated material to this run’s own secret and answers accepted', async () => {
        const rotated = 'material-of-seat-a-rotated'

        await expect(
          reportCredentialRotation(contextFor(asRunA), { fence: 1, material: rotated }, materials),
        ).resolves.toStrictEqual({ accepted: true })

        expect(materials.stored(seatA.secretId)).toBe(rotated)
        expect(materials.stored(seatB.secretId)).toBe(seatB.material)
      })

      it('rejects a superseded fence, leaving the newer material untouched (FR-020)', async () => {
        // A force-release or reconciliation has raised the credential's fence since this holder was
        // issued its own. The holder is partitioned rather than dead and is still writing.
        await setFence(seatA.id, 7)
        const survivor = materials.stored(seatA.secretId)
        const writes = materials.writes.length

        await expect(
          reportCredentialRotation(
            contextFor(asRunA),
            { fence: 1, material: 'material-from-a-displaced-holder' },
            materials,
          ),
        ).resolves.toStrictEqual({ accepted: false, reason: 'stale_fence' })

        expect(materials.stored(seatA.secretId)).toBe(survivor)
        // Refused *before* the store is touched: Secrets Manager versions rather than overwrites, so
        // a refusal that wrote first would leave the superseded material recoverable as the newest.
        expect(materials.writes.length).toBe(writes)
      })

      it('is answered rather than thrown, so a lost claim is not a retry storm', async () => {
        const answer = await reportCredentialRotation(
          contextFor(asRunA),
          { fence: 0, material: 'material-from-a-displaced-holder' },
          materials,
        )

        expect(answer).toStrictEqual({ accepted: false, reason: 'stale_fence' })
      })

      it('rejects `not_newer` when the fence is current but the bytes are unchanged', async () => {
        const stored = materials.stored(seatA.secretId) ?? ''
        const writes = materials.writes.length

        // A healthy holder whose file watcher fired on a touch that changed nothing. Distinct from
        // `stale_fence`: this caller should carry on, the other should stop.
        await expect(
          reportCredentialRotation(
            contextFor(asRunA),
            { fence: await fenceOf(seatA.id), material: stored },
            materials,
          ),
        ).resolves.toStrictEqual({ accepted: false, reason: 'not_newer' })

        expect(materials.writes.length).toBe(writes)
      })

      it('accepts a fence above the credential’s current value rather than losing the rotation', async () => {
        // Unreachable in practice — only acquisition raises the token, and it raises the credential's
        // copy first — but such a writer is not the superseded holder the fence guards against, and
        // refusing it would turn an impossible state into a lost rotation. Matches `isFenceCurrent`.
        await expect(
          reportCredentialRotation(
            contextFor(asRunA),
            {
              fence: (await fenceOf(seatA.id)) + 5,
              material: 'material-from-an-impossible-future',
            },
            materials,
          ),
        ).resolves.toStrictEqual({ accepted: true })
      })

      it('treats a raised fence as a claim, never as a selector — property one', async () => {
        await setFence(seatB.id, 99)
        const untouchedB = materials.stored(seatB.secretId)

        // Run A presents run B's fence. If `fence` were a selector this would reach B's seat; it is
        // not, so it is simply a fence well above A's own — accepted, and written to A.
        await expect(
          reportCredentialRotation(
            contextFor(asRunA),
            { fence: 99, material: 'material-a-tried-to-put-on-seat-b' },
            materials,
          ),
        ).resolves.toStrictEqual({ accepted: true })

        expect(materials.stored(seatA.secretId)).toBe('material-a-tried-to-put-on-seat-b')
        expect(materials.stored(seatB.secretId)).toBe(untouchedB)
      })

      it('accepts a rotation that arrives after its workflow has terminated (FR-032)', async () => {
        const ids = fixture.ids()

        // The full post-terminal shape, not a half of it: the run has an outcome, its lease has been
        // released as `terminal` — and the lease rows are then removed altogether, so this passes
        // only while the rotation path consults neither lease liveness nor run state. A future
        // "tidy-up" that resolved the seat through the live lease fails here rather than shipping a
        // seat whose stored material the provider has already invalidated.
        await fixture
          .db()
          .update(workflows)
          .set({ state: 'succeeded', terminalOutcome: 'succeeded' })
          .where(eq(workflows.id, ids.b.workflowId))

        await fixture
          .db()
          .delete(credentialLeases)
          .where(eq(credentialLeases.workflowId, ids.b.workflowId))

        const rotated = 'material-of-seat-b-rotated-on-the-last-turn'

        await expect(
          reportCredentialRotation(
            contextFor(asRunB),
            { fence: await fenceOf(seatB.id), material: rotated },
            materials,
          ),
        ).resolves.toStrictEqual({ accepted: true })

        expect(materials.stored(seatB.secretId)).toBe(rotated)
      })

      it('still rejects a stale fence after termination — ending a run is not a way past the fence', async () => {
        await expect(
          reportCredentialRotation(
            contextFor(asRunB),
            { fence: 0, material: 'material-from-a-displaced-holder' },
            materials,
          ),
        ).resolves.toStrictEqual({ accepted: false, reason: 'stale_fence' })
      })

      it('refuses when the deployment wired no material store, rather than dropping the rotation', async () => {
        // A store outage is not one of the two rejections — those mean the write was refused on its
        // merits — so it is thrown, and the executor's FR-047 backoff retries it.
        await expect(
          reportCredentialRotation(contextFor(asRunB), { fence: 99, material: 'rotated' }),
        ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
      })

      it('writes anyway when the stored value cannot be read — a dropped rotation strands the seat', async () => {
        const blind: AgentCredentialMaterialStore = {
          read: () => Promise.reject(new Error(MATERIAL_STORE_NOT_CONFIGURED_REASON)),
          write: () => Promise.resolve(),
        }

        // `not_newer` cannot be proven, so it is not claimed. A redundant secret version costs a
        // version; a rotation refused because the platform could not read the old value costs a seat.
        await expect(
          reportCredentialRotation(contextFor(asRunB), { fence: 99, material: 'rotated' }, blind),
        ).resolves.toStrictEqual({ accepted: true })
      })
    })

    describe('a run whose seat has gone', () => {
      it('refuses a fetch once the lease is released — the live lease, not the history', async () => {
        const ids = fixture.ids()

        // Run B's lease rows were removed above, and `workflows.agent_credential_id` still points at
        // seat B. A fetch must not fall back to it: a run that has lost its claim must not be handed
        // material to carry on with.
        await expect(fetchAgentCredential(contextFor(asRunB), materials)).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
        })

        const rows = await fixture
          .db()
          .select({ agentCredentialId: workflows.agentCredentialId })
          .from(workflows)
          .where(eq(workflows.id, ids.b.workflowId))

        expect(rows[0].agentCredentialId).toBe(seatB.id)
      })

      it('refuses a fetch when the seat has no adopted secret (FR-008)', async () => {
        await fixture
          .db()
          .update(agentCredentials)
          .set({ secretId: null })
          .where(eq(agentCredentials.id, seatA.id))

        try {
          await expect(fetchAgentCredential(contextFor(asRunA), materials)).rejects.toMatchObject({
            code: 'PRECONDITION_FAILED',
          })
        } finally {
          await fixture
            .db()
            .update(agentCredentials)
            .set({ secretId: seatA.secretId })
            .where(eq(agentCredentials.id, seatA.id))
        }
      })

      it('refuses a rotation for a run that was never granted a seat', async () => {
        const ids = fixture.ids()
        await fixture
          .db()
          .update(workflows)
          .set({ agentCredentialId: null })
          .where(eq(workflows.id, ids.b.workflowId))

        await expect(
          reportCredentialRotation(
            contextFor(asRunB),
            { fence: 0, material: 'rotated' },
            materials,
          ),
        ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      })
    })
  },
)
