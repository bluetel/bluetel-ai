import { describe, expect, it } from 'vitest'

import { createFakeReachabilityProbe } from './reachability-fake'

const target = (repositoryUrl: string) => ({ repositoryUrl, baseBranch: 'main' })

describe('createFakeReachabilityProbe', () => {
  it('answers reachable by default, so a test states its own problem', async () => {
    await expect(
      createFakeReachabilityProbe().check(target('github.com/acme/api')),
    ).resolves.toStrictEqual({ reachable: true })
  })

  it('records the branch as well as the repository, in call order', async () => {
    const probe = createFakeReachabilityProbe()
    await probe.check({ repositoryUrl: 'github.com/acme/api', baseBranch: 'release/24.1' })
    await probe.check({ repositoryUrl: 'github.com/acme/web', baseBranch: 'main' })

    expect(probe.calls).toStrictEqual([
      { repositoryUrl: 'github.com/acme/api', baseBranch: 'release/24.1' },
      { repositoryUrl: 'github.com/acme/web', baseBranch: 'main' },
    ])
  })

  it('lets one repository answer differently from the rest', async () => {
    const probe = createFakeReachabilityProbe()
    probe.setOutcome('github.com/acme/api', { reachable: false, reason: 'branch not found' })

    await expect(probe.check(target('github.com/acme/api'))).resolves.toStrictEqual({
      reachable: false,
      reason: 'branch not found',
    })
    await expect(probe.check(target('github.com/acme/web'))).resolves.toStrictEqual({
      reachable: true,
    })
  })

  it('rejects on demand, for the transport-failure path', async () => {
    const probe = createFakeReachabilityProbe()
    probe.failWith('github.com/acme/api', new Error('the connection timed out'))

    await expect(probe.check(target('github.com/acme/api'))).rejects.toThrow(
      'the connection timed out',
    )
    // The call is still recorded: a probe that threw was still asked.
    expect(probe.calls).toHaveLength(1)
  })

  it('takes a default outcome, so a suite can start from "nothing is reachable"', async () => {
    const probe = createFakeReachabilityProbe({
      defaultOutcome: { reachable: false, reason: 'no network' },
    })

    await expect(probe.check(target('github.com/acme/api'))).resolves.toStrictEqual({
      reachable: false,
      reason: 'no network',
    })
  })
})
