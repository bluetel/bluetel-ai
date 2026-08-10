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
   *
   * Omitted for the fleet-wide profile the executor's own stack creates at
   * deploy time — see the caveat on `createRunnerRole` in `runner-role.ts`.
   * Grants then fall back to the whole bucket. An **empty string** is not this:
   * it is a caller holding a workflow id it forgot to read, and it still
   * throws, the same as before.
   */
  readonly workflowId?: string
}

const bucketArn = (bucketName: string): string => `arn:aws:s3:::${bucketName}`

/**
 * The S3 resource ARN a grant is scoped to: one workflow's partition when
 * `workflowId` is given, or the whole bucket when it is not — the fleet-wide
 * shape documented on {@link RunnerPolicyConfig.workflowId}.
 */
const runnerObjectArn = (bucketName: string, workflowId: string | undefined): string =>
  workflowId === undefined
    ? `${bucketArn(bucketName)}/*`
    : `${bucketArn(bucketName)}/${getWorkflowObjectPrefix(workflowId)}*`

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
 * - **No bucket-wide access — when a workflow id is known.** Each S3 grant is
 *   scoped to that workflow's partition, so one workflow cannot read another's
 *   logs or snapshots (FR-071), and no grant can list a bucket, so it cannot
 *   enumerate the others. Without a workflow id — the fleet-wide profile the
 *   executor's own stack creates, see `createRunnerRole` in `runner-role.ts` —
 *   a grant is the whole bucket instead, and this isolation does not hold.
 * - **No delete.** Removing a durable object is the lifecycle policy's job.
 * - **No EC2 mutation.** Teardown is the control plane's job (FR-038).
 */
// ---------------------------------------------------------------------------
// The control plane — the one identity allowed to move the fleet
// ---------------------------------------------------------------------------

export interface ControlPlanePolicyConfig {
  /** Region every EC2 resource ARN below is scoped to. */
  readonly region: string
  /** Account every EC2 resource ARN below is scoped to. */
  readonly accountId: string
  /**
   * ARN of the runner role the executor's instances launch with — the exact
   * role `iam:PassRole` is scoped to, and nothing else. A control plane that
   * could pass any role could hand a launched instance whatever privilege it
   * liked, which would make `buildRunnerPolicy`'s careful omissions pointless.
   */
  readonly executorRunnerRoleArn: string
  /**
   * Secrets Manager name prefix the stage's agent credentials live under, from
   * `getAgentCredentialSecretPrefix` in `lib.ts` — never a hand-written string,
   * and never another stage's. Every Secrets Manager grant below is scoped to
   * ARNs beneath it, which is the whole of what stops a staging control plane
   * from reading a production agent's login.
   */
  readonly agentCredentialSecretPrefix: string
  /**
   * Name of the stage's schedule group (`getSchedulerGroupName` in
   * `schedule-name.ts`) — the exact group `scheduler:CreateSchedule`,
   * `UpdateSchedule` and `DeleteSchedule` are scoped to, so `syncSchedules`
   * (FR-100) can register and remove per-integration schedules without
   * reaching another stage's group.
   */
  readonly schedulerGroupName: string
  /**
   * ARN of the role EventBridge Scheduler assumes to invoke the control plane
   * (`schedulerRoleArn` in `sst.config.ts`) — the exact role `iam:PassRole` is
   * scoped to here, since every `CreateSchedule`/`UpdateSchedule` call passes
   * it as the schedule's target role.
   */
  readonly schedulerRoleArn: string
}

/**
 * The control plane's own permission policy: launch an instance (FR-036),
 * destroy one at teardown (FR-038), and enumerate the fleet to reconcile it
 * (FR-039) — see `compute.ts`'s `ComputeProvisioner`, which this policy exists
 * to make deployable — plus the one thing it must do with Secrets Manager, set
 * out below. Nothing else: no S3 and no database IAM action, because the
 * control plane already reaches those through `DATABASE_URL` and the buckets'
 * own bucket policies, not through this role.
 *
 * The Secrets Manager statement is the exception, and it is a narrow one. The
 * control plane is the only member that ever holds agent credential material:
 * it creates a secret when a credential is registered, writes a new version
 * when one is rotated, and reads the current version back when it hands the
 * material to an instance — Postgres stores the identifier and never the
 * material (FR-011, research R8). All four actions are therefore required, and
 * all four are scoped by resource ARN to `agentCredentialSecretPrefix`, which
 * is derived from the plain stage. Two things follow that are worth stating
 * explicitly, because both would deploy cleanly if they were wrong:
 *
 * - **Never `Resource: ['*']`.** A wildcard here would let a staging control
 *   plane read production's agent logins, and — more quietly — every other
 *   secret in the account, including any an unrelated stack happens to own.
 * - **No `secretsmanager:DeleteSecret` and no `secretsmanager:ListSecrets`.**
 *   Retiring a credential is a state change on the row, not the destruction of
 *   the material behind it; a control plane that could delete could lose an
 *   agent's only login with no recovery, and one that could list could
 *   enumerate secrets outside its own prefix regardless of the scoping above,
 *   since `ListSecrets` takes no resource-level permission.
 *
 * An empty prefix is refused rather than formatted into the ARN: it would
 * silently produce `secret:/*`, which is the wildcard this scoping exists to
 * avoid, and it would deploy.
 *
 * `ec2:DescribeInstances` has no resource-level permissions at all — AWS
 * requires `Resource: ['*']` for it regardless of how narrowly the rest of
 * the policy is scoped, so the fleet-visibility statement below is not a
 * missed opportunity to narrow it.
 *
 * `ec2:RunInstances` is scoped to this account and region's `instance`
 * resource so `Ec2ComputeConfiguration.stage` in `compute.ts` never launches
 * outside the stage's own account — but the call also touches every resource
 * a new instance references (its AMI, subnet, security groups, network
 * interface and root volume), and AWS evaluates permission on each of those
 * too. `ec2:CreateTags` is required alongside it for exactly one reason:
 * tagging a resource **at creation** needs the tagging action in addition to
 * the creating one, and `WORKFLOW_ID_TAG` in `compute.ts` is set through
 * `RunInstances`'s own `TagSpecifications`, not a separate call.
 *
 * `syncSchedules` (`jobs/sync-schedules.ts`) needs the control plane to keep
 * EventBridge Scheduler in lockstep with the `integrations` table (FR-100):
 * `scheduler:ListSchedules` finds the sweep's orphans, and
 * `Create`/`Update`/`DeleteSchedule` bring one integration's schedule to the
 * row's desired state. `ListSchedules` has no resource-level permissions —
 * like `ec2:DescribeInstances` above, AWS evaluates it against the literal
 * `schedule/*` /`*` pattern regardless of how narrowly the rest of the policy
 * is scoped — so that statement cannot be narrowed to this stage's group the
 * way the mutating actions are. `CreateSchedule`/`UpdateSchedule` also pass
 * `schedulerRoleArn` as the schedule's target role, which is why
 * `iam:PassRole` is granted on exactly that role and nothing else, mirroring
 * `PassExecutorRunnerRoleToLaunchedInstances` below.
 */
export const buildControlPlanePolicy = (config: ControlPlanePolicyConfig): PolicyDocument => {
  const ec2Resource = (resourceType: string): string =>
    `arn:aws:ec2:${config.region}:${config.accountId}:${resourceType}/*`

  if (config.agentCredentialSecretPrefix.trim() === '') {
    throw new Error(
      'Cannot scope the control plane’s Secrets Manager grant to an empty agent credential prefix, ' +
        'which would widen it to every secret in the account.',
    )
  }

  /**
   * Secrets Manager appends a six-character suffix to the name it is given, so
   * the ARN of a secret created beneath the prefix is
   * `…:secret:{prefix}/{name}-AbCdEf`. Matching on `{prefix}/*` covers exactly
   * the secrets this stage creates there and nothing above or beside it.
   */
  const agentCredentialSecretArn = `arn:aws:secretsmanager:${config.region}:${config.accountId}:secret:${config.agentCredentialSecretPrefix}/*`

  const schedulerGroupResource = `arn:aws:scheduler:${config.region}:${config.accountId}:schedule/${config.schedulerGroupName}/*`

  return {
    Version: POLICY_VERSION,
    Statement: [
      {
        Sid: 'ReconcileFleetVisibility',
        Effect: 'Allow',
        Action: ['ec2:DescribeInstances'],
        Resource: ['*'],
      },
      {
        Sid: 'LaunchAndTerminateExecutorInstances',
        Effect: 'Allow',
        Action: ['ec2:RunInstances', 'ec2:TerminateInstances', 'ec2:CreateTags'],
        Resource: [ec2Resource('instance')],
      },
      {
        Sid: 'RunInstancesResourceDependencies',
        Effect: 'Allow',
        Action: ['ec2:RunInstances'],
        Resource: [
          `arn:aws:ec2:${config.region}::image/*`,
          ec2Resource('subnet'),
          ec2Resource('network-interface'),
          ec2Resource('security-group'),
          ec2Resource('volume'),
        ],
      },
      {
        Sid: 'PassExecutorRunnerRoleToLaunchedInstances',
        Effect: 'Allow',
        Action: ['iam:PassRole'],
        Resource: [config.executorRunnerRoleArn],
      },
      {
        Sid: 'ManageAgentCredentialSecrets',
        Effect: 'Allow',
        Action: [
          'secretsmanager:CreateSecret',
          'secretsmanager:DescribeSecret',
          'secretsmanager:GetSecretValue',
          'secretsmanager:PutSecretValue',
        ],
        Resource: [agentCredentialSecretArn],
      },
      {
        Sid: 'ListRegisteredSchedules',
        Effect: 'Allow',
        Action: ['scheduler:ListSchedules'],
        Resource: [`arn:aws:scheduler:${config.region}:${config.accountId}:schedule/*/*`],
      },
      {
        Sid: 'ManageIntegrationSchedules',
        Effect: 'Allow',
        Action: [
          'scheduler:CreateSchedule',
          'scheduler:UpdateSchedule',
          'scheduler:DeleteSchedule',
        ],
        Resource: [schedulerGroupResource],
      },
      {
        Sid: 'PassSchedulerInvokeRoleToScheduler',
        Effect: 'Allow',
        Action: ['iam:PassRole'],
        Resource: [config.schedulerRoleArn],
      },
    ],
  }
}

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
        runnerObjectArn(config.bucketNames.logs, config.workflowId),
        runnerObjectArn(config.bucketNames.artifacts, config.workflowId),
      ],
    },
    {
      Sid: 'ReadWriteOwnSnapshots',
      Effect: 'Allow',
      Action: ['s3:AbortMultipartUpload', 's3:GetObject', 's3:PutObject'],
      Resource: [runnerObjectArn(config.bucketNames.snapshots, config.workflowId)],
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

// ---------------------------------------------------------------------------
// The panel — registers the archives the executor above only ever reads
// ---------------------------------------------------------------------------

export interface PanelBundlesPolicyConfig {
  /** Region the bundles bucket's KMS key lives in. */
  readonly region: string
  /** Account the bundles bucket's KMS key lives in. */
  readonly accountId: string
  /** Name of the bundles bucket `uploadBundleArchive` writes into. */
  readonly bundlesBucketName: string
}

/**
 * The AWS-managed key S3 encrypts under when a caller asks for `aws:kms` without naming a key of
 * its own — exactly what `ARCHIVE_ENCRYPTION` in `apps/sisyphus-admin/src/lib/bundles/upload.ts`
 * does. Granting this alias, rather than `Resource: ['*']`, is what keeps this statement scoped to
 * the one key an upload can ever touch.
 */
const kmsAwsManagedS3KeyArn = (region: string, accountId: string): string =>
  `arn:aws:kms:${region}:${accountId}:alias/aws/s3`

/**
 * What the panel's own server function may do to the bundles bucket: register an archive
 * (`s3:PutObject`) and encrypt it under the same managed key the upload path asks for. Nothing
 * reads a bundle back through the panel today — validation runs and executor boot both read
 * through the runner role in {@link buildRunnerPolicy} — so this grants no `s3:GetObject`.
 */
export const buildPanelBundlesPolicy = (config: PanelBundlesPolicyConfig): PolicyDocument => ({
  Version: POLICY_VERSION,
  Statement: [
    {
      Sid: 'RegisterSetupBundleArchive',
      Effect: 'Allow',
      Action: ['s3:PutObject'],
      Resource: [`${bucketArn(config.bundlesBucketName)}/*`],
    },
    {
      Sid: 'EncryptSetupBundleArchive',
      Effect: 'Allow',
      Action: ['kms:GenerateDataKey'],
      Resource: [kmsAwsManagedS3KeyArn(config.region, config.accountId)],
    },
  ],
})

export interface PanelPolicyConfig extends PanelBundlesPolicyConfig {
  /**
   * Secrets Manager name prefix the stage's agent credentials live under, from
   * `getAgentCredentialSecretPrefix` in `lib.ts` — the same value
   * {@link ControlPlanePolicyConfig.agentCredentialSecretPrefix} carries, and
   * necessarily so: the control plane writes the secret and the panel's machine
   * surface reads it back, and two prefixes would be two different secrets.
   */
  readonly agentCredentialSecretPrefix: string
}

/**
 * The panel's server function, in full: register a setup bundle archive, and
 * read and write **agent credential material** for the machine surface it
 * mounts (003/FR-011, FR-012, FR-030, FR-032).
 *
 * ## Why the panel needs Secrets Manager at all
 *
 * `machine.fetchAgentCredential` and `machine.reportCredentialRotation` are the
 * only two procedures in the platform that touch credential material, and both
 * are mounted at `/api/machine`, which is a route in the panel's Next.js
 * application (see `apps/sisyphus-admin/src/server/credential-material.ts` for
 * why that mount is the only composition root that can fill the port). So the
 * function that serves them has to be able to reach the store — and until this
 * builder was applied it could not, because
 * `apps/sisyphus-admin/sst.config.ts` passed no `permissions` at all. The
 * symptom is not a deploy failure: it is every instance failing its
 * `credential_install` bootstrap phase with an AWS authorisation error, on a
 * stage that deployed cleanly.
 *
 * ## Two actions, and the four that are deliberately absent
 *
 * `GetSecretValue` is the boot-time fetch; `PutSecretValue` is the rotation the
 * agent performs mid-run and the executor reports back. That is the whole of
 * what this surface does with material, so it is the whole of what it is
 * granted.
 *
 * - **No `CreateSecret`.** Minting a seat's secret is the login capture's act,
 *   performed in the control plane where the material already is. A machine
 *   surface able to create one could file material under an identifier nothing
 *   references and report success; the port the panel implements does not even
 *   declare the method, so this omission makes the deployment agree with the
 *   type rather than merely not contradict it.
 * - **No `DeleteSecret`.** Retiring a credential is a state change on the row.
 *   Deleting the material behind a live seat would lose an agent's only login
 *   with no recovery.
 * - **No `ListSecrets`.** It takes no resource-level permission, so granting it
 *   would let this function enumerate every secret in the account regardless of
 *   how narrowly the ARNs below are scoped.
 * - **No `UpdateSecret`.** It can rewrite a secret's KMS key and description as
 *   well as its value; `PutSecretValue` writes a version and nothing else.
 *
 * The same reasoning as {@link buildControlPlanePolicy}'s Secrets Manager
 * statement, reached independently by the two members that need it, which is
 * why an empty prefix is refused here too rather than formatted into
 * `secret:/*` — a wildcard that would deploy cleanly and let a staging panel
 * read production's agent logins.
 */
export const buildPanelPolicy = (config: PanelPolicyConfig): PolicyDocument => {
  if (config.agentCredentialSecretPrefix.trim() === '') {
    throw new Error(
      'Cannot scope the panel’s Secrets Manager grant to an empty agent credential prefix, ' +
        'which would widen it to every secret in the account.',
    )
  }

  return {
    Version: POLICY_VERSION,
    Statement: [
      // Composed rather than restated: the bundles grants are unchanged, and a
      // second copy of them here would be a second place to get the KMS alias
      // wrong.
      ...buildPanelBundlesPolicy(config).Statement,
      {
        Sid: 'ReadAndWriteAgentCredentialMaterial',
        Effect: 'Allow',
        Action: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
        Resource: [
          `arn:aws:secretsmanager:${config.region}:${config.accountId}:secret:${config.agentCredentialSecretPrefix}/*`,
        ],
      },
    ],
  }
}
