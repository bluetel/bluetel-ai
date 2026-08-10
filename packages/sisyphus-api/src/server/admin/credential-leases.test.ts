import { describe, expect, it } from 'vitest'

import { TERMINAL_OUTCOMES } from '../../enums'

import {
  createRefusingLeaseReleases,
  FORCED_RELEASE_OUTCOME,
  forcedReleaseOutcomeReason,
  LEASE_RELEASE_NOT_CONFIGURED_REASON,
} from './credential-leases'

/**
 * The lease-release seam, its refusing default and the sentence a force-released run is left with
 * (T116, FR-057, FR-058, SC-015).
 *
 * `resolveWorkflowForForcedRelease` is exercised against a real database from
 * `credentials.test.ts`, where the procedure that calls it is: what matters about it is what it
 * writes to `workflows` and `workflow_events` under the row lock, and there is nothing to learn
 * about that from a fake. What is tested here is everything that can be decided without one — the
 * shape of the port, the refusal, and the wording an owner reads on a run that was ended by
 * somebody else's decision.
 */

describe('the refusing lease release', () => {
  it('rejects rather than reporting a release that did not happen', async () => {
    await expect(
      createRefusingLeaseReleases().forceRelease({
        agentCredentialId: '0199a1f4-0000-7000-8000-000000000001',
        workflowId: '0199a1f4-0000-7000-8000-000000000002',
        releasedByUserId: '0199a1f4-0000-7000-8000-000000000003',
      }),
    ).rejects.toThrow(LEASE_RELEASE_NOT_CONFIGURED_REASON)
  })

  it('names the missing configuration rather than blaming the request', () => {
    // The administrator's request was well-formed and they are entitled to make it. What is absent
    // is a deployment concern, and a message that said "could not release" would send them looking
    // at the run.
    expect(LEASE_RELEASE_NOT_CONFIGURED_REASON).toContain('this deployment')
    expect(LEASE_RELEASE_NOT_CONFIGURED_REASON).toContain('force-released')
  })

  it('offers no way to release a lease without naming an administrator', () => {
    // SC-015: `forced` with an actor is a person seizing a seat, `forced` with none is the FR-022
    // sweep tidying up after a run that no longer exists. The sweep reaches `releaseLease`
    // directly, so this port has no reason to admit a null actor — and admitting one would make the
    // distinction between the two a convention rather than a type.
    const request: Parameters<ReturnType<typeof createRefusingLeaseReleases>['forceRelease']>[0] = {
      agentCredentialId: 'a',
      workflowId: 'b',
      releasedByUserId: 'c',
    }

    expect(Object.keys(request).sort()).toStrictEqual([
      'agentCredentialId',
      'releasedByUserId',
      'workflowId',
    ])
  })
})

describe('the outcome a force-released run is recorded under', () => {
  it('is a member of the FR-064 outcomes and is `failed`', () => {
    expect(TERMINAL_OUTCOMES).toContain(FORCED_RELEASE_OUTCOME)
    expect(FORCED_RELEASE_OUTCOME).toBe('failed')
  })

  it('is never `cancelled`, which FR-064 reserves for a person pressing Stop', () => {
    // Nobody stopped this run on its merits. Recording a seizure as a cancellation would flatter
    // the failure numbers in exactly the direction that hides the problem.
    expect(FORCED_RELEASE_OUTCOME).not.toBe('cancelled')
  })
})

describe('the sentence recorded on a force-released run', () => {
  const reason = forcedReleaseOutcomeReason('seat-one', 'ada@example.com')

  it('names the credential and the administrator who took it', () => {
    expect(reason).toContain('seat-one')
    expect(reason).toContain('ada@example.com')
  })

  it('says why the run could not simply continue elsewhere (FR-023)', () => {
    // The owner's first question is whether it can be restarted, and the answer depends on this
    // rule rather than on anything about their run.
    expect(reason).toContain('never moved to a different agent credential')
    expect(reason).toContain('Relaunch it')
  })

  it('carries nothing that could be credential material, because both inputs are names', () => {
    expect(reason).not.toMatch(/sk-|secret value|token/i)
  })
})
