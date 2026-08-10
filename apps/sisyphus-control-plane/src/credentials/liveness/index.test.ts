import { describe, expect, it } from 'vitest'

import * as barrel from './index'

/**
 * The barrel is the directory's public surface, and the shape of it carries the FR-038 guarantee as
 * much as the SQL does.
 *
 * The claim and the exercise are exported **separately**, and there is deliberately no function
 * that does both. That reads like an inconvenience and is the opposite: a `claimAndExercise` would
 * be the one place a caller could not get the order wrong — and also the one place a *second*
 * implementation of the claim could grow, which is exactly how a read-then-act check ends up beside
 * the conditional update it was meant to replace. The sweep is the composed thing, and it is
 * exported; the pieces are exported beside it because the race suite has to drive the claim on its
 * own to prove what a loser observes.
 */

describe('the liveness barrel', () => {
  it('exports the sweep, the three primitives it is built from, and the seam', () => {
    expect(Object.keys(barrel).sort()).toStrictEqual([
      'CREDENTIAL_HOLDER_KEEP_ALIVE',
      'DEFAULT_KEEP_ALIVE_BATCH',
      'KEEP_ALIVE_JOB_NAME',
      'KEEP_ALIVE_OUTCOMES',
      'claimForKeepAlive',
      'createFakeCredentialExerciser',
      'createRefusingCredentialExerciser',
      'credentialsDueForKeepAlive',
      'exerciseCredential',
      'releaseKeepAliveClaim',
      'sweepKeepAlive',
    ])
  })

  it('names the job, so a schedule has one place to find it', () => {
    expect(barrel.KEEP_ALIVE_JOB_NAME).toBe('keep-alive')
  })

  it('names the holder discriminator rather than leaving it a literal at two call sites', () => {
    // The counterpart to `CREDENTIAL_HOLDER_WORKFLOW` in `lease/acquire.ts`. Two claimants that
    // spelled this differently would each be invisible to the other's accounting, and it is what
    // the pool view reads to show its fourth holder kind (FR-074).
    expect(barrel.CREDENTIAL_HOLDER_KEEP_ALIVE).toBe('keep_alive')
  })

  it('records the three outcomes a keep-alive run can have, in the column’s vocabulary', () => {
    // `keep_alive_runs.outcome` is `text` rather than a Postgres enum — see the schema's note on
    // when it would earn one — so this tuple is the only definition of the set there is.
    expect([...barrel.KEEP_ALIVE_OUTCOMES]).toStrictEqual(['succeeded', 'cooling_off', 'failed'])
  })

  it('bounds one pass, because every exercise is a provider round trip', () => {
    expect(barrel.DEFAULT_KEEP_ALIVE_BATCH).toBeGreaterThan(0)
    // A pass that walked an entire pool would turn a schedule into a burst against the provider
    // whose rate limit this feature has a whole state for.
    expect(barrel.DEFAULT_KEEP_ALIVE_BATCH).toBeLessThanOrEqual(100)
  })

  it('offers no way to exercise a credential without claiming it first (FR-038)', () => {
    for (const name of Object.keys(barrel)) {
      expect(name).not.toMatch(/claimAndExercise|exerciseAll|forceExercise/)
    }
  })

  it('offers no second way to claim a seat', () => {
    // `claimForKeepAlive` and `lease/acquire.ts` contend on one conditional update. A `tryClaim` or
    // a `markHeld` here would be a third claimant the other two never see.
    for (const name of Object.keys(barrel)) {
      expect(name).not.toMatch(/^tryClaim|^markHeld|^takeSeat|^reserve/)
    }
  })

  it('defaults the provider seam to something that refuses', async () => {
    // The unwired case must fail loudly. A stub reporting success would mark every seat as freshly
    // proven without reaching a provider, which is SC-009 defeated silently.
    await expect(
      barrel
        .createRefusingCredentialExerciser()
        .exercise({ agentCredentialId: 'a', credentialName: 'n', secretId: 's' }),
    ).rejects.toThrow(/No credential exerciser is wired/)
  })

  it('ships a fake beside the seam, as every other seam in this application does', () => {
    expect(typeof barrel.createFakeCredentialExerciser).toBe('function')
  })
})
