/**
 * The instance profile executor instances boot with.
 *
 * This role is deliberately the *narrowest* identity in the platform. The
 * instance runs a setup bundle supplied by configuration and an agent acting on
 * a prompt, so it must be assumed to be able to run arbitrary code — which
 * makes every permission it holds a permission an untrusted process holds.
 *
 * The two documents that decide that — what the instance may do, and who may
 * assume it — live in `policies.ts`, because a permission granted by mistake
 * deploys perfectly well and so must be asserted as data rather than through the
 * role that carries it. `buildRunnerPolicy` documents the grants and, more
 * importantly, the omissions.
 *
 * ---------------------------------------------------------------------------
 * One role per workflow is the design; one role per fleet is what exists
 * ---------------------------------------------------------------------------
 * `buildRunnerPolicy` scopes every S3 grant to a single workflow's partition,
 * which is what stops one run reading another's logs (FR-071) — but only when
 * it is given a workflow id. That calls for a role created **per launch**, by
 * the control plane, with the id of the workflow it is about to hand the
 * instance.
 *
 * Nothing creates one there yet. Until it does, `apps/sisyphus-executor/sst.config.ts`
 * calls this function **once, at deploy time**, with no `workflowId`, and every
 * instance in the fleet boots with the resulting profile. `buildRunnerPolicy`
 * falls back to granting the whole bucket in that shape, so FR-071's isolation
 * does not hold: any instance can read any workflow's logs, artifacts and
 * snapshots. This is a known, temporary gap — tracked here rather than left
 * silent — not the intended shape of this role.
 */

import { getResourceIdentifier, type ResourceScope } from './lib'
import { buildRunnerPolicy, buildRunnerTrustPolicy, type RunnerPolicyConfig } from './policies'

/**
 * The role name's resource suffix, exported so a caller composing this role's
 * ARN without a handle to the resource itself — the control plane's
 * `iam:PassRole` grant, which must name the exact role it may pass — builds it
 * from the same suffix rather than restating `'executor-runner'` as a second
 * literal that could drift from this one.
 */
export const EXECUTOR_RUNNER_ROLE_NAME = 'executor-runner'

export interface RunnerRoleConfig extends RunnerPolicyConfig {
  readonly scope: ResourceScope
}

export interface RunnerRole {
  readonly role: aws.iam.Role
  readonly rolePolicy: aws.iam.RolePolicy
  readonly instanceProfile: aws.iam.InstanceProfile
}

export const createRunnerRole = (config: RunnerRoleConfig): RunnerRole => {
  const roleName = getResourceIdentifier(config.scope, EXECUTOR_RUNNER_ROLE_NAME)
  const policyName = getResourceIdentifier(config.scope, 'executor-runner-policy')
  const instanceProfileName = getResourceIdentifier(config.scope, 'executor-runner-profile')

  const role = new aws.iam.Role(roleName, {
    name: roleName,
    assumeRolePolicy: JSON.stringify(buildRunnerTrustPolicy()),
  })

  const rolePolicy = new aws.iam.RolePolicy(policyName, {
    name: policyName,
    role: role.name,
    policy: JSON.stringify(buildRunnerPolicy(config)),
  })

  const instanceProfile = new aws.iam.InstanceProfile(instanceProfileName, {
    name: instanceProfileName,
    role: role.name,
  })

  return { role, rolePolicy, instanceProfile }
}
