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
