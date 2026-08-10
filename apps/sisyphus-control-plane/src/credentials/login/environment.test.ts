import { describe, expect, it } from 'vitest'

import { createFakeComputeProvisioner } from '../../aws'

import {
  DEFAULT_LOGIN_TTL_MS,
  destroyLoginEnvironment,
  listLoginEnvironments,
  listUnattributedLoginEnvironments,
  LOGIN_INSTANCE_TYPE,
  LOGIN_MATERIAL_PATH,
  loginUserData,
  provisionLoginEnvironment,
} from './environment'

/**
 * Provisioning and destroying the login environment (T074, FR-069, FR-071).
 *
 * Everything here runs over the recording fake from `aws/compute-fake.ts`, which keeps login
 * instances in a map the workflow sweep cannot see — the same property the real adapter gets from
 * using a different tag key. So "a workflow can never reach this instance" is a claim the seam
 * makes and this module inherits, and what is left to prove here is what the launch *carries*: a
 * deadline computed from the clock, and a boot script with nothing in it.
 */

const now = new Date('2026-08-09T12:00:00.000Z')

describe('provisionLoginEnvironment', () => {
  it('launches a login instance with a deadline computed from the clock', async () => {
    const compute = createFakeComputeProvisioner({ loginInstanceIds: ['i-login-a'] })

    const environment = await provisionLoginEnvironment({
      compute,
      agentCredentialId: 'credential-1',
      credentialName: 'seat-one',
      now,
    })

    expect(environment).toStrictEqual({
      agentCredentialId: 'credential-1',
      environmentId: 'i-login-a',
      startedAt: now,
      expiresAt: new Date(now.getTime() + DEFAULT_LOGIN_TTL_MS),
    })
    expect(compute.loginLaunches[0]?.instanceType).toBe(LOGIN_INSTANCE_TYPE)
    expect(compute.loginLaunches[0]?.expiresAt).toStrictEqual(environment.expiresAt)
  })

  it('takes the lifetime from the caller rather than reading an environment variable', async () => {
    const compute = createFakeComputeProvisioner()

    const environment = await provisionLoginEnvironment({
      compute,
      agentCredentialId: 'credential-1',
      credentialName: 'seat-one',
      ttlMs: 60_000,
      now,
    })

    // Nothing in `src/credentials/` reads the environment; the composition root does, so a stage
    // can be given a different limit without this module knowing there is such a thing as a stage.
    expect(environment.expiresAt).toStrictEqual(new Date(now.getTime() + 60_000))
  })

  it('does not put the instance anywhere a workflow could find it', async () => {
    const compute = createFakeComputeProvisioner()

    await provisionLoginEnvironment({
      compute,
      agentCredentialId: 'credential-1',
      credentialName: 'seat-one',
      now,
    })

    // FR-071, inherited from the seam and asserted here because this is the module that decides
    // which of the two launch methods to call — and calling the wrong one would be silent.
    expect(await compute.listWorkflowInstances()).toStrictEqual([])
    expect(compute.launches).toStrictEqual([])
    expect(await compute.listLoginInstances()).toHaveLength(1)
  })
})

describe('loginUserData', () => {
  it('carries no job, no workspace, no bundle and no credential (FR-069)', () => {
    const script = loginUserData({
      agentCredentialId: 'credential-1',
      credentialName: 'seat-one',
    })

    // The four things a workflow envelope has, none of which apply: there is no run to scope a
    // credential to and no work to check out. An assembler reused with most fields blank would
    // produce an instance that merely happened to have no workspace this time.
    for (const forbidden of ['workspace', 'bundle', 'scopedCredential', 'workflowId']) {
      expect(script).not.toContain(forbidden)
    }
    expect(script).not.toMatch(/https?:\/\//)
  })

  it('prepares the one path the capture reads, and nothing else', () => {
    const script = loginUserData({
      agentCredentialId: 'credential-1',
      credentialName: 'seat-one',
    })

    expect(script).toContain(LOGIN_MATERIAL_PATH)
    expect(script.startsWith('#!/bin/sh')).toBe(true)
  })

  it('names the seat so a person attached to the instance knows which login it is', () => {
    // A name an administrator chose. Never material — there is none at launch time, and the
    // instance is the only place any ever appears.
    expect(
      loginUserData({ agentCredentialId: 'credential-1', credentialName: 'seat-one' }),
    ).toContain('seat-one')
  })
})

describe('destroyLoginEnvironment', () => {
  it('terminates the instance and tolerates being the second caller to try', async () => {
    const compute = createFakeComputeProvisioner({ loginInstanceIds: ['i-login-a'] })
    await provisionLoginEnvironment({
      compute,
      agentCredentialId: 'credential-1',
      credentialName: 'seat-one',
      now,
    })

    await destroyLoginEnvironment({ compute, environmentId: 'i-login-a' })
    // A capture landing a second before the deadline is the interesting race, and both parties
    // destroying the environment must not turn into an error for either of them.
    await destroyLoginEnvironment({ compute, environmentId: 'i-login-a' })

    expect(compute.terminations).toStrictEqual(['i-login-a', 'i-login-a'])
    expect(await compute.listLoginInstances()).toStrictEqual([])
  })
})

describe('listLoginEnvironments', () => {
  it('reports environments this process never started', async () => {
    const compute = createFakeComputeProvisioner()
    compute.seedLoginInstance({
      instanceId: 'i-orphan',
      agentCredentialId: 'credential-9',
      expiresAt: new Date(now.getTime() + DEFAULT_LOGIN_TTL_MS),
      state: 'running',
    })

    // The whole point of listing rather than remembering: the process that started a login may
    // have been replaced, and the instance is the only record there is.
    expect(await listLoginEnvironments({ compute, now })).toStrictEqual([
      {
        agentCredentialId: 'credential-9',
        environmentId: 'i-orphan',
        startedAt: now,
        expiresAt: new Date(now.getTime() + DEFAULT_LOGIN_TTL_MS),
      },
    ])
  })

  it('treats an instance with no readable deadline as already expired', async () => {
    const compute = createFakeComputeProvisioner()
    compute.seedLoginInstance({
      instanceId: 'i-undated',
      agentCredentialId: 'credential-9',
      expiresAt: undefined,
      state: 'running',
    })

    // The safe direction. An interactive instance the platform cannot date is one nobody is
    // accounting for, and dropping it would make it invisible to the only sweep that would find it.
    expect((await listLoginEnvironments({ compute, now }))[0]?.expiresAt).toStrictEqual(now)
  })

  it('leaves an unattributable instance out, and reports it separately so it is still destroyed', async () => {
    const compute = createFakeComputeProvisioner()
    compute.seedLoginInstance({
      instanceId: 'i-nameless',
      agentCredentialId: undefined,
      expiresAt: new Date(now.getTime() - 1),
      state: 'running',
    })

    // Two treatments because the two need different ones: an attributable environment is reaped
    // *and* explained against its seat, and this one can only be reaped — there is no seat.
    expect(await listLoginEnvironments({ compute, now })).toStrictEqual([])
    expect(await listUnattributedLoginEnvironments({ compute })).toStrictEqual(['i-nameless'])
  })

  it('derives the start instant from the deadline it was launched with', async () => {
    const compute = createFakeComputeProvisioner({ loginInstanceIds: ['i-login-a'] })
    await provisionLoginEnvironment({
      compute,
      agentCredentialId: 'credential-1',
      credentialName: 'seat-one',
      ttlMs: 60_000,
      now,
    })

    // Only the deadline is recorded, because only the deadline decides anything. The start instant
    // exists so a panel can show an elapsed time, and it round-trips when the lifetime matches.
    expect(
      (await listLoginEnvironments({ compute, ttlMs: 60_000, now }))[0]?.startedAt,
    ).toStrictEqual(now)
  })
})
