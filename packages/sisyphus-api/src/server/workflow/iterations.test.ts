import { randomUUID } from 'node:crypto'

import { TRPCError } from '@trpc/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import { iterations, reviewFindings } from '../../db'
import type { ResolvedScope } from '../scope'

import { readIterations } from './iterations'
import type { TwoProfileFixture, TwoProfileIds } from './test-support'
import { createTwoProfileFixture, readTestDatabaseUrl, refusalOf } from './test-support'

/**
 * `readIterations` under the FR-190 contract.
 *
 * The interesting case is not "Alice sees her own passes" — it is that Bob's run answers Alice with
 * the *same* refusal a nonexistent id does. An iteration history is a particularly attractive
 * oracle: an empty array would say "this run exists and has no passes", and a `FORBIDDEN` would say
 * "this run exists and is not yours". Both disclose the run. Only `NOT_FOUND`, with the message a
 * nonexistent id gets, does not.
 */

const connectionString = readTestDatabaseUrl()

describe.skipIf(connectionString === undefined)('readIterations is scoped (FR-190)', () => {
  let fixture: TwoProfileFixture
  let db: SisyphusDatabase
  let ids: TwoProfileIds

  let aliceScope: ResolvedScope
  let bobScope: ResolvedScope
  let adminScope: ResolvedScope

  beforeAll(async () => {
    fixture = createTwoProfileFixture(connectionString ?? '')
    await fixture.open()
    db = fixture.db()
    ids = fixture.ids()

    aliceScope = await fixture.scopeFor(ids.alice)
    bobScope = await fixture.scopeFor(ids.bob)
    adminScope = await fixture.scopeFor(ids.admin, true)

    // Two passes on Alice's run, the first carrying a finding, so the ordering and the
    // finding-to-pass association are both observable rather than assumed.
    const [first] = await db
      .insert(iterations)
      .values({ workflowId: ids.a.workflowId, ordinal: 1, reviewVerdict: 'fail' })
      .returning()

    await db
      .insert(iterations)
      .values({ workflowId: ids.a.workflowId, ordinal: 2, reviewVerdict: 'pass' })

    await db.insert(reviewFindings).values({
      iterationId: first.id,
      severity: 'blocker',
      summary: 'The migration drops a column that is still read.',
    })
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  it('returns every pass oldest first, each with its own findings', async () => {
    const passes = await readIterations({ db, scope: aliceScope, workflowId: ids.a.workflowId })

    expect(passes.map((pass) => pass.iteration.ordinal)).toStrictEqual([1, 2])
    expect(passes[0].findings).toHaveLength(1)
    expect(passes[0].findings[0].summary).toContain('drops a column')
    // The second pass passed, so it has none — and an empty list here is a real answer,
    // unlike the empty list an out-of-scope read must never produce.
    expect(passes[1].findings).toStrictEqual([])
  })

  it('refuses another user’s run with NOT_FOUND — never FORBIDDEN, never an empty list', async () => {
    const refusal = await refusalOf(() =>
      readIterations({ db, scope: bobScope, workflowId: ids.a.workflowId }),
    )

    expect(refusal).toBeInstanceOf(TRPCError)
    expect(refusal.code).toBe('NOT_FOUND')
    // Stated separately and deliberately: FORBIDDEN is the intuitive code and it is a disclosure,
    // because it answers "does this run exist?" with yes. So is answering `[]`.
    expect(refusal.code).not.toBe('FORBIDDEN')
  })

  it('refuses an out-of-scope run and a nonexistent one identically', async () => {
    const outOfScope = await refusalOf(() =>
      readIterations({ db, scope: bobScope, workflowId: ids.a.workflowId }),
    )
    const nonexistent = await refusalOf(() =>
      readIterations({ db, scope: bobScope, workflowId: randomUUID() }),
    )

    // Identical code *and* identical message. A message that named the run — or merely differed —
    // would answer "does this exist?" for anyone who tried both.
    expect(outOfScope.code).toBe(nonexistent.code)
    expect(outOfScope.message).toBe(nonexistent.message)
    expect(outOfScope.message).not.toContain(ids.a.workflowId)
  })

  it('lets an admin read the same run', async () => {
    const passes = await readIterations({ db, scope: adminScope, workflowId: ids.a.workflowId })

    expect(passes.map((pass) => pass.iteration.ordinal)).toStrictEqual([1, 2])
  })

  it('answers an in-scope run with no passes as an empty list', async () => {
    // Distinct from the refusal above, and the reason that refusal cannot be an empty list: this
    // run *is* visible, so an empty history is the truth rather than a concealment.
    const passes = await readIterations({ db, scope: bobScope, workflowId: ids.b.workflowId })

    expect(passes).toStrictEqual([])
  })
})
