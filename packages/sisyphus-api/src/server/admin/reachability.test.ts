import { describe, expect, it } from 'vitest'

import {
  createRefusingReachabilityProbe,
  probeTargets,
  REACHABILITY_NOT_CONFIGURED_REASON,
} from './reachability'
import { createFakeReachabilityProbe } from './reachability-fake'

const target = (repositoryUrl: string) => ({ repositoryUrl, baseBranch: 'main' })

describe('createRefusingReachabilityProbe', () => {
  it('reports every target as unreachable, so an unwired deployment enables nothing (FR-124)', async () => {
    // The failure this guards against is a default that answers "reachable" having checked
    // nothing: the gate would look present in every diagram and refuse nothing in practice.
    await expect(
      createRefusingReachabilityProbe().check(target('github.com/acme/api')),
    ).resolves.toStrictEqual({ reachable: false, reason: REACHABILITY_NOT_CONFIGURED_REASON })
  })

  it('says why, rather than failing anonymously', () => {
    expect(REACHABILITY_NOT_CONFIGURED_REASON).toContain('no repository reachability checker')
  })
})

describe('probeTargets', () => {
  it('keeps results in the order the targets were given', async () => {
    const probe = createFakeReachabilityProbe()
    const reports = await probeTargets(probe, [
      target('github.com/acme/api'),
      target('github.com/acme/web'),
    ])

    expect(reports.map((report) => report.target.repositoryUrl)).toStrictEqual([
      'github.com/acme/api',
      'github.com/acme/web',
    ])
    expect(reports.every((report) => report.outcome.reachable)).toBe(true)
  })

  it('probes every target even after one fails, so an admin sees the whole list', async () => {
    const probe = createFakeReachabilityProbe()
    probe.setOutcome('github.com/acme/api', { reachable: false, reason: 'branch not found' })

    const reports = await probeTargets(probe, [
      target('github.com/acme/api'),
      target('github.com/acme/web'),
    ])

    expect(probe.calls).toHaveLength(2)
    expect(reports[0]?.outcome).toStrictEqual({ reachable: false, reason: 'branch not found' })
    expect(reports[1]?.outcome.reachable).toBe(true)
  })

  it('turns a rejected probe into an unreachable verdict rather than losing the entry', async () => {
    const probe = createFakeReachabilityProbe()
    probe.failWith('github.com/acme/api', new Error('the connection timed out'))

    const reports = await probeTargets(probe, [target('github.com/acme/api')])

    // A transport error is exactly the state FR-124 refuses to enable through. Letting it escape
    // as a 500 would tell the admin nothing about which entry was involved.
    expect(reports[0]?.outcome).toStrictEqual({
      reachable: false,
      reason: 'the connection timed out',
    })
  })

  it('probes nothing when there is nothing to probe', async () => {
    const probe = createFakeReachabilityProbe()
    await expect(probeTargets(probe, [])).resolves.toStrictEqual([])
    expect(probe.calls).toStrictEqual([])
  })
})
