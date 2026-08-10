import { describe, expect, it } from 'vitest'

import { createFakeComputeProvisioner } from './compute-fake'

describe('the fake compute provisioner', () => {
  it('records launches and answers the sweep consistently with them', async () => {
    const compute = createFakeComputeProvisioner({ instanceIds: ['i-a', 'i-b'] })

    const first = await compute.launch({
      workflowId: 'workflow-1',
      instanceType: 'c7g.large',
      purchaseMode: 'spot',
      userData: 'envelope-1',
    })
    await compute.launch({
      workflowId: 'workflow-2',
      instanceType: 'c7g.xlarge',
      purchaseMode: 'on_demand',
      userData: 'envelope-2',
    })

    expect(first.instanceId).toBe('i-a')
    expect(compute.launches.map((launch) => launch.workflowId)).toEqual([
      'workflow-1',
      'workflow-2',
    ])
    expect(await compute.listWorkflowInstances()).toEqual([
      { instanceId: 'i-a', workflowId: 'workflow-1', state: 'running' },
      { instanceId: 'i-b', workflowId: 'workflow-2', state: 'running' },
    ])
  })

  it('generates ids once the supplied ones run out', async () => {
    const compute = createFakeComputeProvisioner()

    const launched = await compute.launch({
      workflowId: 'workflow-1',
      instanceType: 'c7g.large',
      purchaseMode: 'spot',
      userData: 'x',
    })

    expect(launched.instanceId).toBe('i-fake-1')
  })

  it('drops a terminated instance and tolerates terminating one it never had', async () => {
    const compute = createFakeComputeProvisioner({ instanceIds: ['i-a'] })
    await compute.launch({
      workflowId: 'workflow-1',
      instanceType: 'c7g.large',
      purchaseMode: 'spot',
      userData: 'x',
    })

    await compute.terminate({ instanceId: 'i-a' })
    await compute.terminate({ instanceId: 'i-never-existed' })

    expect(compute.terminations).toEqual(['i-a', 'i-never-existed'])
    expect(await compute.listWorkflowInstances()).toEqual([])
  })

  it('fails one launch on request, then resumes — the capacity-refusal path', async () => {
    const compute = createFakeComputeProvisioner({ instanceIds: ['i-a'] })
    compute.failNextLaunch(new Error('InsufficientInstanceCapacity'))

    const request = {
      workflowId: 'workflow-1',
      instanceType: 'c7g.large',
      purchaseMode: 'spot' as const,
      userData: 'x',
    }
    await expect(compute.launch(request)).rejects.toThrow('InsufficientInstanceCapacity')
    expect(compute.launches).toEqual([])

    await expect(compute.launch(request)).resolves.toMatchObject({ instanceId: 'i-a' })
  })

  it('seeds an instance the control plane never launched, so a leak can be found', async () => {
    const compute = createFakeComputeProvisioner()
    compute.seedInstance({ instanceId: 'i-orphan', workflowId: 'workflow-gone', state: 'running' })

    expect(await compute.listWorkflowInstances()).toEqual([
      { instanceId: 'i-orphan', workflowId: 'workflow-gone', state: 'running' },
    ])
    expect(compute.launches).toEqual([])
  })
})

/**
 * **Stop, start, and the volume in between (T093, 003/FR-039, FR-041, FR-043).**
 *
 * Every pause test written over this fake rests on one behaviour, and it is the one asserted first
 * below: a stopped instance keeps its volume, and a terminated one does not. A lenient fake here —
 * one that answered `describeVolumes` from a list nothing ever removed from — would let a pause
 * that silently destroyed a working tree pass its own tests, because the fake would hand back a
 * disk whatever had happened to the instance. That is the whole reason these assertions are about
 * the *fake* rather than only about the jobs that use it.
 */
describe('the fake compute provisioner’s stop, start and disk (003/FR-039)', () => {
  const launch = async (compute: ReturnType<typeof createFakeComputeProvisioner>) =>
    compute.launch({
      workflowId: 'workflow-1',
      instanceType: 'c7g.large',
      purchaseMode: 'on_demand',
      userData: 'x',
    })

  it('keeps a stopped instance’s volume, which is what a pause is (FR-039)', async () => {
    const compute = createFakeComputeProvisioner({ instanceIds: ['i-a'] })
    await launch(compute)
    const before = await compute.describeVolumes({ instanceId: 'i-a' })

    const transition = await compute.stop({ instanceId: 'i-a' })

    expect(transition).toEqual({
      instanceId: 'i-a',
      previousState: 'running',
      currentState: 'stopped',
    })
    expect(compute.stops).toEqual(['i-a'])
    // The same volume, still attached. If this ever answers `[]`, every pause test in the
    // repository is asserting against a fake that lost the working tree it claims to have kept.
    await expect(compute.describeVolumes({ instanceId: 'i-a' })).resolves.toEqual(before)
    expect(before).toHaveLength(1)
    // And the instance is still there to be started again — stopped, not gone.
    expect(await compute.listWorkflowInstances()).toEqual([
      { instanceId: 'i-a', workflowId: 'workflow-1', state: 'stopped' },
    ])
  })

  it('destroys the volume on terminate, which is what the spot path costs (FR-043)', async () => {
    const compute = createFakeComputeProvisioner({ instanceIds: ['i-a'] })
    await launch(compute)

    await compute.terminate({ instanceId: 'i-a' })

    // Nothing left to resume from except the durable snapshot. That asymmetry between stop and
    // terminate is the reason spot pauses degrade to snapshot recovery rather than to a stop.
    await expect(compute.describeVolumes({ instanceId: 'i-a' })).resolves.toEqual([])
    expect(await compute.listWorkflowInstances()).toEqual([])
  })

  it('starts a stopped instance back into running, over the same volume', async () => {
    const compute = createFakeComputeProvisioner({ instanceIds: ['i-a'] })
    await launch(compute)
    await compute.stop({ instanceId: 'i-a' })

    const transition = await compute.start({ instanceId: 'i-a' })

    expect(transition).toEqual({
      instanceId: 'i-a',
      previousState: 'stopped',
      currentState: 'running',
    })
    expect(compute.starts).toEqual(['i-a'])
    // No second launch: FR-041's "without re-provisioning" is observable here as a launch count.
    expect(compute.launches).toHaveLength(1)
    await expect(compute.describeVolumes({ instanceId: 'i-a' })).resolves.toHaveLength(1)
  })

  it('fails one start on request — the stopped instance that will not come back (FR-043)', async () => {
    const compute = createFakeComputeProvisioner({ instanceIds: ['i-a'] })
    await launch(compute)
    await compute.stop({ instanceId: 'i-a' })
    compute.failNextStart(new Error('InsufficientInstanceCapacity'))

    await expect(compute.start({ instanceId: 'i-a' })).rejects.toThrow(
      'InsufficientInstanceCapacity',
    )
    // The instance is untouched by the refusal: still stopped, still holding its disk. The
    // recovery path has to give both up deliberately rather than find them already gone.
    expect(await compute.listWorkflowInstances()).toEqual([
      { instanceId: 'i-a', workflowId: 'workflow-1', state: 'stopped' },
    ])
    await expect(compute.describeVolumes({ instanceId: 'i-a' })).resolves.toHaveLength(1)

    await expect(compute.start({ instanceId: 'i-a' })).resolves.toMatchObject({
      currentState: 'running',
    })
  })

  it('fails one stop on request — the pause that cannot be taken', async () => {
    const compute = createFakeComputeProvisioner({ instanceIds: ['i-a'] })
    await launch(compute)
    compute.failNextStop(new Error('UnsupportedOperation'))

    await expect(compute.stop({ instanceId: 'i-a' })).rejects.toThrow('UnsupportedOperation')
    expect(await compute.listWorkflowInstances()).toEqual([
      { instanceId: 'i-a', workflowId: 'workflow-1', state: 'running' },
    ])
  })

  it('refuses to stop or start an instance it has never had', async () => {
    const compute = createFakeComputeProvisioner()

    // Unlike `terminate`, which tolerates the unknown because the real API does. A pause that
    // reported success against an instance nobody can see would be reporting a run as cheaply
    // paused while its real instance went on billing.
    await expect(compute.stop({ instanceId: 'i-ghost' })).rejects.toThrow(/never had/)
    await expect(compute.start({ instanceId: 'i-ghost' })).rejects.toThrow(/never had/)
  })

  it('gives a seeded instance a disk too, so a leak can be paused as well as found', async () => {
    const compute = createFakeComputeProvisioner()
    compute.seedInstance({ instanceId: 'i-orphan', workflowId: 'workflow-gone', state: 'running' })

    await compute.stop({ instanceId: 'i-orphan' })

    await expect(compute.describeVolumes({ instanceId: 'i-orphan' })).resolves.toHaveLength(1)
  })

  it('answers empty for the volumes of an instance it has never had', async () => {
    const compute = createFakeComputeProvisioner()

    await expect(compute.describeVolumes({ instanceId: 'i-ghost' })).resolves.toEqual([])
  })
})

/**
 * The login half of the fake (T073, 003/FR-069, 003/FR-071).
 *
 * The bar for a fake is not "records what it was asked to do" — it is that a later phase testing
 * against it cannot pass on behaviour the real seam would not exhibit. Two things follow from that
 * and are asserted below: a login environment never appears in the workflow sweep, and a login
 * environment can exist without this process having launched it.
 */
describe('the fake compute provisioner’s login environments', () => {
  const expiresAt = new Date('2026-08-09T12:30:00.000Z')

  it('records login launches and answers the login sweep consistently with them', async () => {
    const compute = createFakeComputeProvisioner({ loginInstanceIds: ['i-login-a'] })

    const launched = await compute.launchLogin({
      agentCredentialId: 'credential-1',
      instanceType: 't4g.small',
      expiresAt,
      userData: 'login-boot',
    })

    expect(launched).toEqual({
      instanceId: 'i-login-a',
      agentCredentialId: 'credential-1',
      expiresAt,
    })
    expect(compute.loginLaunches.map((launch) => launch.agentCredentialId)).toEqual([
      'credential-1',
    ])
    expect(await compute.listLoginInstances()).toEqual([
      {
        instanceId: 'i-login-a',
        agentCredentialId: 'credential-1',
        expiresAt,
        state: 'running',
      },
    ])
  })

  it('generates login ids once the supplied ones run out, in their own sequence', async () => {
    const compute = createFakeComputeProvisioner()
    await compute.launch({
      workflowId: 'workflow-1',
      instanceType: 'c7g.large',
      purchaseMode: 'spot',
      userData: 'x',
    })

    const launched = await compute.launchLogin({
      agentCredentialId: 'credential-1',
      instanceType: 't4g.small',
      expiresAt,
      userData: 'x',
    })

    // A shared counter would make login ids depend on how many workflows a test happened to
    // launch first, which is exactly the kind of coupling a fake should not invent.
    expect(launched.instanceId).toBe('i-fake-login-1')
  })

  /**
   * **The faithfulness assertion.** The real adapter puts no `sisyphus:workflow-id` on a login
   * instance, so EC2 cannot return one from the workflow sweep. If the fake could, every
   * reconciliation test written over it would be testing a world that does not exist.
   */
  it('never returns a login environment from the workflow sweep, or the reverse', async () => {
    const compute = createFakeComputeProvisioner({
      instanceIds: ['i-workflow'],
      loginInstanceIds: ['i-login'],
    })

    await compute.launch({
      workflowId: 'workflow-1',
      instanceType: 'c7g.large',
      purchaseMode: 'spot',
      userData: 'x',
    })
    await compute.launchLogin({
      agentCredentialId: 'credential-1',
      instanceType: 't4g.small',
      expiresAt,
      userData: 'x',
    })

    expect((await compute.listWorkflowInstances()).map((instance) => instance.instanceId)).toEqual([
      'i-workflow',
    ])
    expect((await compute.listLoginInstances()).map((instance) => instance.instanceId)).toEqual([
      'i-login',
    ])
    // And the request records stay separate too: a login is not a launch that happened to have no
    // workflow, and a test asserting "one workflow was provisioned" must not count it as one.
    expect(compute.launches).toHaveLength(1)
    expect(compute.loginLaunches).toHaveLength(1)
  })

  it('terminates a login environment through the same method, and tolerates repeats', async () => {
    const compute = createFakeComputeProvisioner({ loginInstanceIds: ['i-login'] })
    await compute.launchLogin({
      agentCredentialId: 'credential-1',
      instanceType: 't4g.small',
      expiresAt,
      userData: 'x',
    })

    await compute.terminate({ instanceId: 'i-login' })
    await compute.terminate({ instanceId: 'i-login' })

    expect(compute.terminations).toEqual(['i-login', 'i-login'])
    expect(await compute.listLoginInstances()).toEqual([])
  })

  it('seeds a login environment nothing in this process launched — the reaper’s whole case', async () => {
    const compute = createFakeComputeProvisioner()

    // An administrator started a login, the panel process was replaced, and the only record that
    // the instance exists is the instance. That is what the wall-clock reaper is for.
    compute.seedLoginInstance({
      instanceId: 'i-abandoned',
      agentCredentialId: 'credential-1',
      expiresAt,
      state: 'running',
    })

    expect(await compute.listLoginInstances()).toHaveLength(1)
    expect(compute.loginLaunches).toEqual([])
    expect(await compute.listWorkflowInstances()).toEqual([])
  })

  it('fails one login launch on request, then resumes', async () => {
    const compute = createFakeComputeProvisioner({ loginInstanceIds: ['i-login'] })
    compute.failNextLoginLaunch(new Error('InsufficientInstanceCapacity'))

    const request = {
      agentCredentialId: 'credential-1',
      instanceType: 't4g.small',
      expiresAt,
      userData: 'x',
    }
    await expect(compute.launchLogin(request)).rejects.toThrow('InsufficientInstanceCapacity')
    expect(compute.loginLaunches).toEqual([])
    // Nothing was created, so nothing is left for the reaper to find — a failed launch must not
    // look like an abandoned login.
    expect(await compute.listLoginInstances()).toEqual([])

    await expect(compute.launchLogin(request)).resolves.toMatchObject({ instanceId: 'i-login' })
  })
})
