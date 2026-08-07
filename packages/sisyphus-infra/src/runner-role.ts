/**
 * The instance profile executor instances boot with.
 *
 * This role is deliberately the *narrowest* identity in the platform. The
 * instance runs a setup bundle supplied by configuration and an agent acting on
 * a prompt, so it must be assumed to be able to run arbitrary code — which
 * makes every permission it holds a permission an untrusted process holds.
 *
 * What it therefore does **not** get, and why:
 *
 * - **No database access of any kind.** `sisyphus-api` is the only member that
 *   touches PostgreSQL; the executor reaches the platform through the
 *   workflow-scoped machine surface credential and nothing else (FR-005,
 *   FR-037). There is no `rds:*`, no `rds-db:connect`, and no read of the
 *   connection-URL parameter.
 * - **No Secrets Manager and no Parameter Store.** Every credential the job
 *   needs arrives in the user-data envelope, scoped to one workflow.
 * - **No bucket-wide access.** Each S3 grant is scoped to that workflow's
 *   partition, so one workflow cannot read another's logs or snapshots
 *   (FR-071).
 * - **No EC2 mutation.** Teardown is the control plane's job (FR-038).
 */

import { getWorkflowObjectPrefix, type BucketObjectClass } from './buckets'
import {
  POLICY_VERSION,
  getResourceIdentifier,
  type PolicyDocument,
  type ResourceScope,
} from './lib'

export interface RunnerRoleConfig {
  readonly scope: ResourceScope
  /** Bucket name per object class, as produced by `buildBucketSpecifications`. */
  readonly bucketNames: Readonly<Record<BucketObjectClass, string>>
  /**
   * Workflow the instance is running. Every S3 grant is scoped to this
   * workflow's partition; a fleet-wide role would defeat FR-071's partitioning.
   */
  readonly workflowId: string
}

const bucketArn = (bucketName: string): string => `arn:aws:s3:::${bucketName}`

const workflowObjectArn = (bucketName: string, workflowId: string): string =>
  `${bucketArn(bucketName)}/${getWorkflowObjectPrefix(workflowId)}*`

/**
 * The trust policy: only the EC2 service may assume this role, and only by
 * being launched with the instance profile.
 */
export const buildRunnerTrustPolicy = (): PolicyDocument => ({
  Version: POLICY_VERSION,
  Statement: [
    {
      Sid: 'Ec2InstanceAssumption',
      Effect: 'Allow',
      Principal: { Service: ['ec2.amazonaws.com'] },
      Action: ['sts:AssumeRole'],
    },
  ],
})

/**
 * The permission policy. Read the setup bundle, write logs and artifacts, read
 * and write this workflow's snapshots, and hold a Session Manager channel for
 * operator access. Nothing else.
 */
export const buildRunnerPolicy = (config: RunnerRoleConfig): PolicyDocument => ({
  Version: POLICY_VERSION,
  Statement: [
    {
      Sid: 'ReadSetupBundleArchive',
      Effect: 'Allow',
      Action: ['s3:GetObject'],
      Resource: [`${bucketArn(config.bucketNames.bundles)}/*`],
    },
    {
      Sid: 'WriteOwnLogsAndArtifacts',
      Effect: 'Allow',
      Action: ['s3:AbortMultipartUpload', 's3:PutObject'],
      Resource: [
        workflowObjectArn(config.bucketNames.logs, config.workflowId),
        workflowObjectArn(config.bucketNames.artifacts, config.workflowId),
      ],
    },
    {
      Sid: 'ReadWriteOwnSnapshots',
      Effect: 'Allow',
      Action: ['s3:AbortMultipartUpload', 's3:GetObject', 's3:PutObject'],
      Resource: [workflowObjectArn(config.bucketNames.snapshots, config.workflowId)],
    },
    {
      Sid: 'SessionManagerChannel',
      Effect: 'Allow',
      Action: [
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel',
      ],
      Resource: ['*'],
    },
  ],
})

export interface RunnerRoleSpecification {
  readonly roleName: string
  readonly instanceProfileName: string
  readonly policyName: string
  readonly trustPolicy: PolicyDocument
  readonly policy: PolicyDocument
}

export const buildRunnerRoleSpecification = (
  config: RunnerRoleConfig,
): RunnerRoleSpecification => ({
  roleName: getResourceIdentifier(config.scope, 'executor-runner'),
  instanceProfileName: getResourceIdentifier(config.scope, 'executor-runner-profile'),
  policyName: getResourceIdentifier(config.scope, 'executor-runner-policy'),
  trustPolicy: buildRunnerTrustPolicy(),
  policy: buildRunnerPolicy(config),
})

/**
 * The narrow slice of the SST/Pulumi provider surface this primitive needs.
 * `sst.config.ts` supplies constructors closing over the real `aws` global.
 */
export interface RunnerRoleProvider<TRole, TPolicy, TInstanceProfile> {
  readonly createRole: (
    name: string,
    args: { readonly name: string; readonly assumeRolePolicy: PolicyDocument },
  ) => TRole
  readonly createRolePolicy: (
    name: string,
    args: { readonly name: string; readonly role: TRole; readonly policy: PolicyDocument },
  ) => TPolicy
  readonly createInstanceProfile: (
    name: string,
    args: { readonly name: string; readonly role: TRole },
  ) => TInstanceProfile
}

export interface CreatedRunnerRole<TRole, TPolicy, TInstanceProfile> {
  readonly specification: RunnerRoleSpecification
  readonly role: TRole
  readonly rolePolicy: TPolicy
  readonly instanceProfile: TInstanceProfile
}

export const createRunnerRole = <TRole, TPolicy, TInstanceProfile>(
  provider: RunnerRoleProvider<TRole, TPolicy, TInstanceProfile>,
  config: RunnerRoleConfig,
): CreatedRunnerRole<TRole, TPolicy, TInstanceProfile> => {
  const specification = buildRunnerRoleSpecification(config)

  const role = provider.createRole(specification.roleName, {
    name: specification.roleName,
    assumeRolePolicy: specification.trustPolicy,
  })

  const rolePolicy = provider.createRolePolicy(specification.policyName, {
    name: specification.policyName,
    role,
    policy: specification.policy,
  })

  const instanceProfile = provider.createInstanceProfile(specification.instanceProfileName, {
    name: specification.instanceProfileName,
    role,
  })

  return { specification, role, rolePolicy, instanceProfile }
}
