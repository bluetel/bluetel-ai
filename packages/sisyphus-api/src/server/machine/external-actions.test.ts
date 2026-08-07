import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { externalActions } from '../../db'
import type { ExternalActionResult } from '../../enums'
import { reportExternalActionInput } from '../../schemas'
import type { MachineCredential } from '../context'

import type { ExternalActionReport } from './external-actions'
import { reportExternalAction, supersedesExternalActionResult } from './external-actions'
import type { MachineFixture } from './test-support'
import { createMachineFixture, readTestDatabaseUrl } from './test-support'

/**
 * `machine.reportExternalAction` — exactly-once across processes, not merely within one (T180,
 * FR-076, FR-077).
 *
 * ## What this suite has to prove that no existing one could
 *
 * `apps/sisyphus-executor/src/delivery/external-action.ts` already prevents a duplicate comment
 * inside a single process, with a `new Map()`. Its tests prove that, and they would pass just as
 * happily if the durable half did not exist — which, until this procedure, it did not: nothing had
 * ever inserted a row into `external_actions`, so the unique index the spec names as the guarantee
 * was guarding an empty table.
 *
 * The failure that costs a customer something is therefore invisible to those tests. An instance is
 * reclaimed mid-delivery. A replacement is provisioned. Its ledger is a fresh, empty map, so it
 * knows nothing about the comment the previous instance posted, and it posts a second one.
 *
 * {@link deliverThroughSurface} below is that scenario made runnable. It is a deliberately faithful
 * miniature of the executor's delivery step — derive the key, ask, perform only if entitled, report
 * the outcome — and every call to it constructs a **new empty ledger**, which is what "another
 * process" means here. The assertion is on `posted`: the remote is touched once across as many
 * processes as the test cares to run.
 */

const connectionString = readTestDatabaseUrl()

/** The derived key for one action, as `externalActionKey` in the executor builds it. */
const COMMENT_KEY = 'comment-posted:PROJ-1:review-complete'

describe('the external-action payload', () => {
  it('requires an idempotency key — deduplication cannot be optional (FR-077)', () => {
    expect(() =>
      reportExternalActionInput.parse({
        kind: 'comment_posted',
        targetReference: 'PROJ-1',
        result: 'pending',
        attemptCount: 1,
      }),
    ).toThrow()
  })

  it('refuses a blank key, which would collide with every other blank one', () => {
    expect(() =>
      reportExternalActionInput.parse({
        kind: 'comment_posted',
        targetReference: 'PROJ-1',
        idempotencyKey: '   ',
        result: 'pending',
        attemptCount: 1,
      }),
    ).toThrow()
  })
})

/**
 * The progression rule, checked against a table rather than through a database.
 *
 * Pure and separate from the write for the same reason `honestTerminalOutcome` is: the awkward
 * combinations are worth stating directly, and the one that matters — a retried failure report
 * arriving after a success — is the hardest to seed and the most expensive to get wrong.
 */
describe('supersedesExternalActionResult', () => {
  const cases: readonly [ExternalActionResult, ExternalActionResult, boolean][] = [
    ['pending', 'succeeded', true],
    ['pending', 'failed', true],
    ['pending', 'pending', false],
    ['failed', 'succeeded', true],
    ['failed', 'failed', false],
    ['failed', 'pending', false],
    // The one that licenses a duplicate if it is wrong. FR-047 retries a report whose response was
    // lost, so "the report failed" arrives looking exactly like "the action failed".
    ['succeeded', 'failed', false],
    ['succeeded', 'pending', false],
    ['succeeded', 'succeeded', false],
  ]

  for (const [stored, reported, expected] of cases) {
    it(`${stored} + ${reported} → ${expected ? 'replaced' : 'kept'}`, () => {
      expect(supersedesExternalActionResult(stored, reported)).toBe(expected)
    })
  }
})

describe.skipIf(connectionString === undefined)('reportExternalAction', () => {
  let fixture: MachineFixture
  let credential: MachineCredential

  beforeAll(async () => {
    fixture = createMachineFixture(connectionString ?? '')
    await fixture.open()
    credential = await fixture.seedCredential(fixture.ids().a.workflowId)
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  const rowsFor = async (idempotencyKey: string) =>
    fixture
      .db()
      .select()
      .from(externalActions)
      .where(
        and(
          eq(externalActions.workflowId, fixture.ids().a.workflowId),
          eq(externalActions.idempotencyKey, idempotencyKey),
        ),
      )

  const claim = async (
    idempotencyKey: string,
    result: ExternalActionResult,
    attemptCount = 1,
  ): Promise<ExternalActionReport> =>
    reportExternalAction(fixture.contextFor(credential).ctx, {
      kind: 'comment_posted',
      targetReference: 'PROJ-1',
      idempotencyKey,
      result,
      attemptCount,
    })

  it('claims an unseen action, and the claim is the row (FR-076)', async () => {
    const report = await claim('first-claim', 'pending')

    expect(report.claimed).toBe(true)
    expect(report.alreadyPerformed).toBe(false)
    expect(report.action.workflowId).toBe(fixture.ids().a.workflowId)
    expect(await rowsFor('first-claim')).toHaveLength(1)
  })

  it('refuses the claim to every later caller, through the unique index', async () => {
    const second = await claim('first-claim', 'pending')

    expect(second.claimed).toBe(false)
    // Still one row. The index, not a check that races, is what makes that true.
    expect(await rowsFor('first-claim')).toHaveLength(1)
  })

  it('settles pending → succeeded, and then says so to everyone', async () => {
    const settled = await claim('first-claim', 'succeeded', 2)

    expect(settled.action.result).toBe('succeeded')
    expect(settled.alreadyPerformed).toBe(true)
    expect((await claim('first-claim', 'pending')).alreadyPerformed).toBe(true)
  })

  it('never lets a retried failure erase a recorded success (FR-047)', async () => {
    const late = await claim('first-claim', 'failed', 3)

    expect(late.action.result).toBe('succeeded')
    expect(late.alreadyPerformed).toBe(true)
  })

  it('moves attemptCount under greatest, so a stale report cannot walk it back', async () => {
    await claim('attempts', 'pending', 1)
    await claim('attempts', 'pending', 4)
    await claim('attempts', 'pending', 2)

    const rows = await rowsFor('attempts')

    expect(rows).toHaveLength(1)
    expect(rows[0].attemptCount).toBe(4)
  })

  it('scopes the key to the run — two runs proposing the same action are two actions', async () => {
    const other = await fixture.seedCredential(fixture.ids().b.workflowId)

    const report = await reportExternalAction(fixture.contextFor(other).ctx, {
      kind: 'comment_posted',
      targetReference: 'PROJ-1',
      idempotencyKey: 'first-claim',
      result: 'pending',
      attemptCount: 1,
    })

    // Workflow B claims the identical key freely: the index is on
    // `(workflow_id, kind, idempotency_key)`, and a key that spanned runs would suppress the
    // second run's genuinely distinct action.
    expect(report.claimed).toBe(true)
    expect(report.action.workflowId).toBe(fixture.ids().b.workflowId)
  })

  it('treats a different kind on the same target as a different action', async () => {
    const transitioned = await reportExternalAction(fixture.contextFor(credential).ctx, {
      kind: 'ticket_transitioned',
      targetReference: 'PROJ-1',
      idempotencyKey: 'first-claim',
      result: 'pending',
      attemptCount: 1,
    })

    expect(transitioned.claimed).toBe(true)
  })

  /**
   * The requirement, stated as the scenario that used to break it.
   *
   * Each call gets a ledger of its own, so nothing carries over between them but the database —
   * which is exactly the situation after a re-provision, and exactly the situation the executor's
   * own in-memory tests construct away.
   */
  describe('a replayed action across processes, with the in-memory ledger cold', () => {
    /** How many times the remote was actually touched, across every simulated process. */
    let posted = 0

    /**
     * One delivery attempt in one process.
     *
     * @param attemptCount - Which attempt this process believes it is making.
     * @returns What the process decided to do.
     */
    const deliverThroughSurface = async (
      attemptCount: number,
    ): Promise<'posted' | 'skipped-already-performed' | 'skipped-not-claimed'> => {
      // A fresh process: its ledger knows nothing, which is the whole point.
      const ledger = new Map<string, 'posted'>()

      if (ledger.has(COMMENT_KEY)) {
        return 'skipped-already-performed'
      }

      const report = await reportExternalAction(fixture.contextFor(credential).ctx, {
        kind: 'comment_posted',
        targetReference: 'PROJ-1',
        idempotencyKey: COMMENT_KEY,
        result: 'pending',
        attemptCount,
      })

      if (report.alreadyPerformed) {
        return 'skipped-already-performed'
      }
      if (!report.claimed) {
        return 'skipped-not-claimed'
      }

      // Only here does anything reach the customer.
      posted += 1
      ledger.set(COMMENT_KEY, 'posted')

      await reportExternalAction(fixture.contextFor(credential).ctx, {
        kind: 'comment_posted',
        targetReference: 'PROJ-1',
        idempotencyKey: COMMENT_KEY,
        result: 'succeeded',
        attemptCount,
      })

      return 'posted'
    }

    it('posts once and only once, however many instances run the delivery', async () => {
      expect(await deliverThroughSurface(1)).toBe('posted')

      // The instance is reclaimed here. Everything the first process learned is gone.
      expect(await deliverThroughSurface(1)).toBe('skipped-already-performed')
      expect(await deliverThroughSurface(2)).toBe('skipped-already-performed')
      expect(await deliverThroughSurface(3)).toBe('skipped-already-performed')

      expect(posted).toBe(1)
      expect(await rowsFor(COMMENT_KEY)).toHaveLength(1)
    })

    it('lets exactly one of several concurrent processes claim it', async () => {
      const before = posted
      const key = `${COMMENT_KEY}:concurrent`

      const claims = await Promise.all(
        [1, 2, 3, 4, 5].map(async (attempt) =>
          reportExternalAction(fixture.contextFor(credential).ctx, {
            kind: 'comment_posted',
            targetReference: 'PROJ-2',
            idempotencyKey: key,
            result: 'pending',
            attemptCount: attempt,
          }),
        ),
      )

      // The index arbitrates. Nothing here is serialised by the test.
      expect(claims.filter((report) => report.claimed)).toHaveLength(1)
      expect(await rowsFor(key)).toHaveLength(1)
      expect(posted).toBe(before)
    })
  })
})
