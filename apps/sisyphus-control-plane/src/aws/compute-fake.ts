import type {
  ComputeProvisioner,
  LaunchComputeRequest,
  LaunchedCompute,
  WorkflowInstance,
} from './compute'

/**
 * Recording fake for {@link ComputeProvisioner} — the reason T054 exists.
 *
 * The control plane's whole job is to create and destroy compute, so without a fake at this seam
 * every test of admission, provisioning, teardown or reconciliation would need real capacity. This
 * one keeps an in-memory instance table so it answers `listWorkflowInstances` consistently with the
 * launches and terminations it was given — which is what makes it usable for the FR-039 sweep, not
 * only for asserting that a launch was requested.
 *
 * Exported from the `aws` barrel so other jobs' tests take it rather than writing a fifth stub.
 */

export interface FakeComputeProvisioner extends ComputeProvisioner {
  /** Every launch request, in order. */
  readonly launches: readonly LaunchComputeRequest[]
  /** Every instance id passed to `terminate`, in order, including repeats. */
  readonly terminations: readonly string[]
  /**
   * Fail the next `launch` with this error — capacity refusal, most usefully, since that is the
   * case a provisioning job has to turn into a recorded outcome rather than an unhandled rejection.
   */
  readonly failNextLaunch: (error: Error) => void
  /**
   * Add an instance the control plane never launched, so a reconciliation test has a leak to find.
   */
  readonly seedInstance: (instance: WorkflowInstance) => void
}

export interface FakeComputeProvisionerOptions {
  /** Instance ids to hand out, in order. Defaults to `i-fake-1`, `i-fake-2`, … */
  readonly instanceIds?: readonly string[]
}

export const createFakeComputeProvisioner = (
  options: FakeComputeProvisionerOptions = {},
): FakeComputeProvisioner => {
  const launches: LaunchComputeRequest[] = []
  const terminations: string[] = []
  const instances = new Map<string, WorkflowInstance>()
  const suppliedIds = [...(options.instanceIds ?? [])]
  let launchCount = 0
  let nextLaunchError: Error | undefined

  const nextInstanceId = (): string => {
    launchCount += 1
    return suppliedIds.shift() ?? `i-fake-${launchCount}`
  }

  return {
    launches,
    terminations,

    failNextLaunch: (error) => {
      nextLaunchError = error
    },

    seedInstance: (instance) => {
      instances.set(instance.instanceId, instance)
    },

    launch: (request): Promise<LaunchedCompute> => {
      if (nextLaunchError !== undefined) {
        const error = nextLaunchError
        nextLaunchError = undefined
        return Promise.reject(error)
      }

      launches.push(request)
      const instanceId = nextInstanceId()
      instances.set(instanceId, {
        instanceId,
        workflowId: request.workflowId,
        state: 'running',
      })

      return Promise.resolve({
        instanceId,
        instanceType: request.instanceType,
        purchaseMode: request.purchaseMode,
      })
    },

    terminate: (input) => {
      terminations.push(input.instanceId)
      // Terminating something unknown is deliberately not an error: the real API tolerates it, and
      // a teardown retrying after a partial failure must not fail on the second attempt.
      instances.delete(input.instanceId)
      return Promise.resolve()
    },

    listWorkflowInstances: () => Promise.resolve([...instances.values()]),
  }
}
