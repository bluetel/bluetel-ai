import type {
  AttachedVolume,
  ComputeProvisioner,
  InstanceTransition,
  LaunchComputeRequest,
  LaunchedCompute,
  LaunchLoginRequest,
  LaunchedLoginEnvironment,
  LoginInstance,
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
 *
 * ## The two populations are separate here too, and that is the point of the fake (T073)
 *
 * The real adapter keeps workflow instances and login environments apart by giving them different
 * EC2 tag keys and filtering each sweep on its own (see `compute.ts`). A fake that kept them in one
 * table and filtered on a discriminator would be *behaviourally* different in the case that
 * matters: a bug that put a workflow id on a login instance would show up against EC2 and not
 * against the fake, and every later phase testing over this fake would pass on behaviour the real
 * seam does not exhibit. So the fake keeps **two maps that no operation moves anything between**,
 * and `listWorkflowInstances` genuinely cannot return a login environment because it never looks in
 * that map. `terminate` is the one operation that spans both, exactly as it does in EC2.
 *
 * ## The volume is modelled, because pause is a claim about the volume (T093, 003/FR-039)
 *
 * Every pause test in this repository rests on one behaviour: **a stopped instance keeps its disk,
 * and a terminated one does not.** A fake that answered `describeVolumes` from a list it never
 * mutated would let that behaviour break in the adapter without a single test going red — the pause
 * job would still "observe" a retained volume, because the fake would hand one back whatever had
 * happened to the instance.
 *
 * So this fake gives every launched instance a root volume, keeps it across `stop` and `start`, and
 * destroys it on `terminate` exactly as `DeleteOnTermination` does. The difference between pausing
 * an on-demand instance and pausing a spot one is then a difference this fake actually exhibits,
 * rather than one the tests assert about themselves.
 */

export interface FakeComputeProvisioner extends ComputeProvisioner {
  /** Every workflow launch request, in order. */
  readonly launches: readonly LaunchComputeRequest[]
  /** Every login launch request, in order (003/FR-069). */
  readonly loginLaunches: readonly LaunchLoginRequest[]
  /** Every instance id passed to `terminate`, in order, including repeats and either kind. */
  readonly terminations: readonly string[]
  /** Every instance id passed to `stop`, in order (003/FR-039). */
  readonly stops: readonly string[]
  /** Every instance id passed to `start`, in order (003/FR-041). */
  readonly starts: readonly string[]
  /**
   * Fail the next `launch` with this error — capacity refusal, most usefully, since that is the
   * case a provisioning job has to turn into a recorded outcome rather than an unhandled rejection.
   */
  readonly failNextLaunch: (error: Error) => void
  /**
   * Fail the next `launchLogin`. Separate from {@link FakeComputeProvisioner.failNextLaunch}
   * because the two failures are handled by different callers with different obligations: a refused
   * workflow launch is queued or recorded against the run, while a refused login must leave a
   * reason against the credential for the administrator who is looking at it (003/FR-009).
   */
  readonly failNextLoginLaunch: (error: Error) => void
  /**
   * Fail the next `stop` — the on-demand pause that cannot be taken.
   *
   * Its own hook rather than a shared one, because the caller's obligation is specific: a stop that
   * fails leaves a *running* instance the pause must give up some other way, and 003/FR-043 says
   * which way. See `jobs/pause-instance.ts`.
   */
  readonly failNextStop: (error: Error) => void
  /**
   * Fail the next `start` — **the case 003/FR-043 exists for**, and the reason this hook is not
   * optional machinery.
   *
   * A stopped instance that will not start again is the failure that makes pause dangerous: the
   * disk is there, the platform believes the run is resumable, and the capacity is not. Without a
   * way to produce it here, the recovery path would be code nothing ever ran.
   */
  readonly failNextStart: (error: Error) => void
  /**
   * Add an instance the control plane never launched, so a reconciliation test has a leak to find.
   *
   * @param instance - The instance. It is given a root volume like a launched one, so a seeded
   *   instance can be stopped, started and asked about its disk exactly as a launched one can.
   */
  readonly seedInstance: (instance: WorkflowInstance) => void
  /**
   * Add a login environment the control plane never launched — a login started before the process
   * that started it was replaced. This is the reaper's whole reason for existing, so it must be
   * expressible without going through `launchLogin` first (003/FR-071).
   */
  readonly seedLoginInstance: (instance: LoginInstance) => void
}

export interface FakeComputeProvisionerOptions {
  /** Instance ids to hand out, in order. Defaults to `i-fake-1`, `i-fake-2`, … */
  readonly instanceIds?: readonly string[]
  /** Login instance ids to hand out, in order. Defaults to `i-fake-login-1`, … */
  readonly loginInstanceIds?: readonly string[]
}

export const createFakeComputeProvisioner = (
  options: FakeComputeProvisionerOptions = {},
): FakeComputeProvisioner => {
  const launches: LaunchComputeRequest[] = []
  const loginLaunches: LaunchLoginRequest[] = []
  const terminations: string[] = []
  const stops: string[] = []
  const starts: string[] = []
  const instances = new Map<string, WorkflowInstance>()
  const loginInstances = new Map<string, LoginInstance>()
  /** Attached volumes, keyed by instance. Emptied by `terminate` and by nothing else. */
  const volumes = new Map<string, AttachedVolume[]>()
  const suppliedIds = [...(options.instanceIds ?? [])]
  const suppliedLoginIds = [...(options.loginInstanceIds ?? [])]
  let launchCount = 0
  let loginLaunchCount = 0
  let volumeCount = 0
  let nextLaunchError: Error | undefined
  let nextLoginLaunchError: Error | undefined
  let nextStopError: Error | undefined
  let nextStartError: Error | undefined

  const nextInstanceId = (): string => {
    launchCount += 1
    return suppliedIds.shift() ?? `i-fake-${launchCount}`
  }

  const nextLoginInstanceId = (): string => {
    loginLaunchCount += 1
    return suppliedLoginIds.shift() ?? `i-fake-login-${loginLaunchCount}`
  }

  /**
   * Give an instance the root volume EC2 would have given it.
   *
   * `deleteOnTermination` is true, which is what the launch's block-device defaults produce and
   * what makes the spot pause path genuinely destructive in this fake as it is in the account.
   */
  const attachRootVolume = (instanceId: string): void => {
    volumeCount += 1
    volumes.set(instanceId, [
      {
        volumeId: `vol-fake-${volumeCount}`,
        instanceId,
        deviceName: '/dev/xvda',
        sizeGib: 100,
        state: 'in-use',
        deleteOnTermination: true,
      },
    ])
  }

  /**
   * Move an instance between lifecycle states, or say why it could not be moved.
   *
   * Unknown instances raise rather than resolving, which is the one place this fake is deliberately
   * *stricter* than tolerant: `StopInstances` against an instance that does not exist fails at EC2
   * too, and a pause job that quietly succeeded against a vanished instance would report a run as
   * cheaply paused while its actual instance — wherever the platform lost track of it — went on
   * billing.
   */
  const transition = (
    instanceId: string,
    verb: 'start' | 'stop',
    to: string,
  ): InstanceTransition => {
    const instance = instances.get(instanceId)

    if (instance === undefined) {
      throw new Error(
        `The fake compute provisioner was asked to ${verb} instance ${instanceId}, which it has never had. EC2 answers InvalidInstanceID.NotFound for this, and a caller that treated it as success would be reporting an outcome about an instance nobody can see.`,
      )
    }

    instances.set(instanceId, { ...instance, state: to })

    return { instanceId, previousState: instance.state, currentState: to }
  }

  return {
    launches,
    loginLaunches,
    terminations,
    stops,
    starts,

    failNextLaunch: (error) => {
      nextLaunchError = error
    },

    failNextLoginLaunch: (error) => {
      nextLoginLaunchError = error
    },

    failNextStop: (error) => {
      nextStopError = error
    },

    failNextStart: (error) => {
      nextStartError = error
    },

    seedInstance: (instance) => {
      instances.set(instance.instanceId, instance)
      attachRootVolume(instance.instanceId)
    },

    seedLoginInstance: (instance) => {
      loginInstances.set(instance.instanceId, instance)
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
      attachRootVolume(instanceId)

      return Promise.resolve({
        instanceId,
        instanceType: request.instanceType,
        purchaseMode: request.purchaseMode,
      })
    },

    /**
     * Record a login launch and put the instance in the **login** map.
     *
     * Nothing here writes to `instances`, and that omission is the fake's faithfulness: the real
     * adapter writes no `sisyphus:workflow-id` tag, so EC2 cannot return a login environment from
     * the workflow sweep, and neither can this.
     */
    launchLogin: (request): Promise<LaunchedLoginEnvironment> => {
      if (nextLoginLaunchError !== undefined) {
        const error = nextLoginLaunchError
        nextLoginLaunchError = undefined
        return Promise.reject(error)
      }

      loginLaunches.push(request)
      const instanceId = nextLoginInstanceId()
      loginInstances.set(instanceId, {
        instanceId,
        agentCredentialId: request.agentCredentialId,
        expiresAt: request.expiresAt,
        state: 'running',
      })

      return Promise.resolve({
        instanceId,
        agentCredentialId: request.agentCredentialId,
        expiresAt: request.expiresAt,
      })
    },

    terminate: (input) => {
      terminations.push(input.instanceId)
      // Terminating something unknown is deliberately not an error: the real API tolerates it, and
      // a teardown retrying after a partial failure must not fail on the second attempt. One
      // method covers both populations because one `TerminateInstances` call does.
      instances.delete(input.instanceId)
      loginInstances.delete(input.instanceId)
      // And the disk goes with it. This one line is the difference between the two pause paths:
      // stopping keeps the working tree, terminating destroys it and leaves the durable snapshot as
      // the only thing a resume can be built from (003/FR-039, FR-043).
      volumes.delete(input.instanceId)
      return Promise.resolve()
    },

    /**
     * Stop the instance and **leave its volumes exactly where they are** (003/FR-039).
     *
     * The omission is the model: there is no `volumes.delete` on this path, and that absence is
     * what every pause test in the repository is standing on.
     *
     * It settles immediately — `currentState` is `stopped` where EC2 would say `stopping` — because
     * this fake has no clock and nothing in the control plane waits for the transition. A caller
     * that *did* wait would be relying on a delay this fake cannot produce, which is worth knowing
     * before writing one.
     */
    stop: (input) => {
      if (nextStopError !== undefined) {
        const error = nextStopError
        nextStopError = undefined
        return Promise.reject(error)
      }

      stops.push(input.instanceId)

      try {
        return Promise.resolve(transition(input.instanceId, 'stop', 'stopped'))
      } catch (thrown) {
        return Promise.reject(thrown instanceof Error ? thrown : new Error(String(thrown)))
      }
    },

    start: (input) => {
      if (nextStartError !== undefined) {
        const error = nextStartError
        nextStartError = undefined
        return Promise.reject(error)
      }

      starts.push(input.instanceId)

      try {
        return Promise.resolve(transition(input.instanceId, 'start', 'running'))
      } catch (thrown) {
        return Promise.reject(thrown instanceof Error ? thrown : new Error(String(thrown)))
      }
    },

    describeVolumes: (input) => Promise.resolve([...(volumes.get(input.instanceId) ?? [])]),

    listWorkflowInstances: () => Promise.resolve([...instances.values()]),

    listLoginInstances: () => Promise.resolve([...loginInstances.values()]),
  }
}
