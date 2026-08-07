/**
 * Every IAM policy document the platform issues, and the exact identity claim
 * the CI deploy role will accept.
 *
 * ---------------------------------------------------------------------------
 * Why this is its own module
 * ---------------------------------------------------------------------------
 * A policy document is plain, serialisable data, and it is the one part of the
 * infrastructure where a mistake **succeeds**. A wildcard `sub` claim deploys
 * cleanly and hands every branch of the repository production credentials; an
 * S3 resource ARN missing its workflow partition deploys cleanly and lets one
 * workflow read another's logs. Neither shows up as a failed deploy, so neither
 * can be left to deploy-time verification (FR-200).
 *
 * Nothing here imports a provider SDK. The builders take plain strings — a
 * caller holding a Pulumi `Output<string>` resolves it before calling one —
 * which is what keeps the documents assertable without an SST install.
 */

import { POLICY_VERSION, type PolicyDocument } from './lib'
import { getWorkflowObjectPrefix, type ObjectClass } from './retention'
import { isDeployStage, type DeployStage } from './sst-app'

// ---------------------------------------------------------------------------
// GitHub Actions OIDC — the CI identity
// ---------------------------------------------------------------------------

export const GITHUB_OIDC_ISSUER_URL = 'https://token.actions.githubusercontent.com'

/** The claim namespace AWS exposes the GitHub token's claims under. */
export const GITHUB_OIDC_CLAIM_PREFIX = 'token.actions.githubusercontent.com'

export const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com'

/**
 * GitHub's certificate thumbprints. AWS no longer verifies these for the
 * well-known GitHub issuer, but the field is still required on creation.
 */
export const GITHUB_OIDC_THUMBPRINTS: readonly string[] = [
  '6938fd4d98bab03faadb97b34396831e3780aea1',
  '1c58a3a8518e8759bf075b76b750d4f2df264fcd',
]

/**
 * The one branch each deployable stage may be deployed from.
 *
 * Keyed by {@link DeployStage} rather than by `string`, so the set of stages CI
 * can deploy and the set of stages with a protected branch cannot drift apart:
 * adding a deploy stage without deciding its branch fails to compile.
 */
const DEPLOY_BRANCH_REF: Readonly<Record<DeployStage, string>> = {
  production: 'refs/heads/main',
  staging: 'refs/heads/staging',
}

/**
 * The protected branch `stage` deploys from, or `undefined` for any stage that
 * has none: personal stages are deployed from a developer's own credentials and
 * are deliberately given no CI identity.
 */
export const getDeployBranchRef = (stage: string): string | undefined =>
  isDeployStage(stage) ? DEPLOY_BRANCH_REF[stage] : undefined

const describeDeployBranches = (): string =>
  Object.entries(DEPLOY_BRANCH_REF)
    .map(([stage, ref]) => `"${stage}" (${ref})`)
    .join(' and ')

/**
 * The exact `sub` claim a GitHub Actions token must carry to assume the deploy
 * role for `stage`.
 *
 * @example
 * getTrustedSubject('bluetel/universal-react-monorepo', 'production')
 * // → 'repo:bluetel/universal-react-monorepo:ref:refs/heads/main'
 */
export const getTrustedSubject = (githubRepo: string, stage: string): string => {
  const ref = getDeployBranchRef(stage)

  if (ref === undefined) {
    throw new Error(
      `Stage "${stage}" has no protected deploy branch, so no CI deploy role can be issued for it. ` +
        `Only ${describeDeployBranches()} deploy from CI.`,
    )
  }

  return `repo:${githubRepo}:ref:${ref}`
}

export interface DeployRoleTrustPolicyConfig {
  /** ARN of the identity provider, already resolved from any Pulumi output. */
  readonly oidcProviderArn: string
  /** Repository in `org/repo` form. */
  readonly githubRepo: string
  /** Plain stage name the role deploys. */
  readonly stage: string
}

/**
 * The deploy role's trust policy. `StringEquals` on `sub`, never `StringLike`:
 * a wildcard would trust every branch and every pull-request workflow in the
 * repository, which is the exact failure FR-067 is written against.
 */
export const buildDeployRoleTrustPolicy = (
  config: DeployRoleTrustPolicyConfig,
): PolicyDocument => ({
  Version: POLICY_VERSION,
  Statement: [
    {
      Sid: 'GitHubActionsProtectedBranch',
      Effect: 'Allow',
      Principal: { Federated: [config.oidcProviderArn] },
      Action: ['sts:AssumeRoleWithWebIdentity'],
      Condition: {
        StringEquals: {
          [`${GITHUB_OIDC_CLAIM_PREFIX}:aud`]: [GITHUB_OIDC_AUDIENCE],
          [`${GITHUB_OIDC_CLAIM_PREFIX}:sub`]: [getTrustedSubject(config.githubRepo, config.stage)],
        },
      },
    },
  ],
})

// ---------------------------------------------------------------------------
// The executor instance — the narrowest identity in the platform
// ---------------------------------------------------------------------------

export interface RunnerPolicyConfig {
  /** Bucket name per object class. */
  readonly bucketNames: Readonly<Record<ObjectClass, string>>
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
 * The trust policy: only the EC2 service may assume the runner role, and only by
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
 * The executor's permission policy. Read the setup bundle, write logs and
 * artifacts, read and write this workflow's snapshots, and hold a Session
 * Manager channel for operator access. Nothing else.
 *
 * The instance runs a setup bundle supplied by configuration and an agent acting
 * on a prompt, so it must be assumed able to run arbitrary code — every
 * permission granted here is a permission an untrusted process holds. What it
 * therefore does **not** get, and why:
 *
 * - **No database access of any kind.** `sisyphus-api` is the only member that
 *   touches PostgreSQL; the executor reaches the platform through the
 *   workflow-scoped machine surface credential and nothing else (FR-005,
 *   FR-037). No `rds:*`, no `rds-db:connect`, no read of the connection-URL
 *   parameter.
 * - **No Secrets Manager and no Parameter Store.** Every credential the job
 *   needs arrives in the user-data envelope, scoped to one workflow.
 * - **No bucket-wide access.** Each S3 grant is scoped to that workflow's
 *   partition, so one workflow cannot read another's logs or snapshots
 *   (FR-071), and no grant can list a bucket, so it cannot enumerate the others.
 * - **No delete.** Removing a durable object is the lifecycle policy's job.
 * - **No EC2 mutation.** Teardown is the control plane's job (FR-038).
 */
export const buildRunnerPolicy = (config: RunnerPolicyConfig): PolicyDocument => ({
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
