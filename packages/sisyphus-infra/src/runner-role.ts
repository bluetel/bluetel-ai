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
 * One role per workflow, not one per fleet: every S3 grant is scoped to a single
 * workflow's partition, which is what stops one run reading another's logs
 * (FR-071). That is why the control plane calls this per launch rather than the
 * executor's stack calling it once at deploy time.
 */

import { getResourceIdentifier, type ResourceScope } from './lib'
import { buildRunnerPolicy, buildRunnerTrustPolicy, type RunnerPolicyConfig } from './policies'

export interface RunnerRoleConfig extends RunnerPolicyConfig {
  readonly scope: ResourceScope
}

export interface RunnerRole {
  readonly role: aws.iam.Role
  readonly rolePolicy: aws.iam.RolePolicy
  readonly instanceProfile: aws.iam.InstanceProfile
}

export const createRunnerRole = (config: RunnerRoleConfig): RunnerRole => {
  const roleName = getResourceIdentifier(config.scope, 'executor-runner')
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
