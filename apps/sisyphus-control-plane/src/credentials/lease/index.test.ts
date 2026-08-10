import { describe, expect, it } from 'vitest'

import * as barrel from './index'

/**
 * The barrel is the directory's public surface, so what it does — and does not — export is a
 * contract in its own right.
 *
 * The exclusivity guarantee is a property of one transaction, so the shape of this surface is part
 * of it: there is a function that takes a seat and a function that gives one back, and no way to
 * perform half of either. An exported "claim this credential" or "mark this lease released" would
 * be a second, weaker path to the same rows — one without the audit entry, or without the
 * conditional update, or without both.
 */

describe('the lease barrel', () => {
  it('exports the three operations a seat has in its life', () => {
    for (const name of ['acquireCredential', 'releaseLease', 'persistRotation'] as const) {
      expect(typeof barrel[name]).toBe('function')
    }
  })

  it('exports the fence comparison on its own, so a caller can ask before it writes', () => {
    expect(barrel.isFenceCurrent({ presentedFence: 3, currentFence: 3 })).toBe(true)
    expect(barrel.isFenceCurrent({ presentedFence: 2, currentFence: 3 })).toBe(false)
  })

  it('names the refusal and the two indexes that enforce exclusivity', () => {
    // Exported so a caller matches on Postgres's own `constraint_name` rather than on an error
    // message — Drizzle's wrapper puts the failing SQL in `message`, so text matching would treat a
    // null violation as a lost race.
    expect(barrel.STALE_FENCE).toBe('stale_fence')
    expect(barrel.LEASE_EXCLUSIVITY_INDEX).toBe('credential_leases_live_key')
    expect(barrel.WORKFLOW_EXCLUSIVITY_INDEX).toBe('credential_leases_workflow_live_key')
  })

  it('names the holder discriminator, so two claimants cannot spell it differently', () => {
    // Keep-alive claims the same idle row through the same conditional update (FR-038) and writes
    // the other value. A literal at each call site is how the pool view acquires a fourth holder
    // kind nobody can query for.
    expect(barrel.CREDENTIAL_HOLDER_WORKFLOW).toBe('workflow')
  })

  it('publishes the retry bound rather than hiding it in the implementation', () => {
    // The number is a policy about how long admission spends discovering drift, and it is worth
    // being readable from outside the module that spends it.
    expect(barrel.DEFAULT_MAX_ACQUISITION_ATTEMPTS).toBeGreaterThan(0)
    expect(Number.isInteger(barrel.DEFAULT_MAX_ACQUISITION_ATTEMPTS)).toBe(true)
  })

  it('exports exactly this runtime surface and nothing else', () => {
    // Types erase, so this is all of it. An equality rather than a `toContain`, so that widening
    // the surface is a deliberate edit here as well as there.
    expect([...Object.keys(barrel)].sort()).toStrictEqual([
      'CREDENTIAL_HOLDER_WORKFLOW',
      'DEFAULT_MAX_ACQUISITION_ATTEMPTS',
      'LEASE_EXCLUSIVITY_INDEX',
      'STALE_FENCE',
      'WORKFLOW_EXCLUSIVITY_INDEX',
      'acquireCredential',
      'isFenceCurrent',
      'persistRotation',
      'releaseLease',
    ])
  })

  it('offers no way to perform half of an acquisition', () => {
    // The conditional update, the lease insert and the audit row are only correct together. Any of
    // them reachable on its own would be a way to take a seat without the guarantee.
    for (const name of [
      'claimCredential',
      'insertLease',
      'markLeaseReleased',
      'recordLeaseAudit',
      'bumpFence',
      'raiseFence',
    ]) {
      expect(Object.keys(barrel)).not.toContain(name)
    }
  })

  it('does not export the test support', () => {
    for (const name of ['createCredentialPoolFixtures', 'createGate', 'readTestDatabaseUrl']) {
      expect(Object.keys(barrel)).not.toContain(name)
    }
  })
})
