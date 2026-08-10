import { describe, expect, it } from 'vitest'

import * as barrel from './index'

/**
 * The barrel is the directory's public surface, so what it does — and does not — export is a
 * contract in its own right.
 *
 * The absences matter more than the presences here. A fixture that creates and drops databases, and
 * anything that would let a caller ask for a credential by group or by profile rather than by
 * workflow, are both one export away from being reachable from production code — and the second
 * would quietly turn SC-016 from an invariant of one query into something every call site has to
 * get right.
 */

describe('the allocate barrel', () => {
  it('exports selection, and it is callable', () => {
    expect(typeof barrel.selectFor).toBe('function')
    // Two arguments — the reader and the workflow — so a caller cannot forget the handle and get a
    // module-level connection instead.
    expect(barrel.selectFor.length).toBe(2)
  })

  it('exports the wait report beside selection, and it too takes only a workflow', () => {
    // FR-029. Selection says "nothing" by returning no row; this says *which* nothing, because the
    // remedy differs in each case. Same shape as selection — a reader and a workflow — so it cannot
    // be asked about a group or a profile either.
    expect(typeof barrel.describeWaitReason).toBe('function')
    expect(barrel.describeWaitReason.length).toBe(2)
  })

  it('exports exactly two runtime values', () => {
    // Types erase, so this is the whole runtime surface. Stated as an equality rather than a
    // `toContain` so that adding something here is a deliberate edit to this test.
    expect(Object.keys(barrel)).toStrictEqual(['selectFor', 'describeWaitReason'])
  })

  it('does not export the test support', () => {
    // `pool-fixtures.ts` creates and drops databases. One import away from the allocator is not
    // where that belongs, whatever the comment at the top of it says.
    for (const name of [
      'createCredentialPoolFixtures',
      'createGate',
      'readTestDatabaseUrl',
      'scratchDatabaseName',
      'withDatabaseName',
      'TEST_DATABASE_URL_VARIABLE',
    ]) {
      expect(Object.keys(barrel)).not.toContain(name)
    }
  })

  it('offers no way to ask for a credential by group or by profile (SC-016)', () => {
    // The scoping invariant holds because the workflow id is the only way in. A `selectForGroup` or
    // `selectForProfile` on this barrel would be the same query with the guarantee deleted.
    for (const name of Object.keys(barrel)) {
      expect(name).not.toMatch(/Group$|Profile$|ByGroup|ByProfile/)
    }
  })

  it('exposes no way to claim a credential, only to be offered one', () => {
    // Acquisition is `../lease/acquire.ts`, in one transaction with the lease insert and the audit
    // row. A claim reachable from this barrel would be a second, weaker way to take a seat.
    for (const name of Object.keys(barrel)) {
      expect(name).not.toMatch(/acquire|claim|lease|reserve/i)
    }
  })
})
