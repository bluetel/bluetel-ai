/**
 * Naming and secret helpers shared by every construct in this package, plus the
 * plain-data shape of an IAM policy document.
 *
 * Nothing here reaches for a Pulumi or SST global, and nothing here creates a
 * resource. These are the decisions FR-200 keeps directly assertable: what a
 * resource is called, which parameter path a stage publishes to, and the shape
 * a policy document must take. A construct reads a value from here and hands it
 * to a constructor; the constructor is the deploy's problem, the value is not.
 */

import { getPlainStage } from './get-plain-stage'
import type { ObjectClass } from './retention'

/** The project and stack a set of resources is being named under. */
export interface ResourceScope {
  /** Project component, identical across the three deployables. */
  readonly project: string
  /** Plain stage name — the stack every deployable shares for that stage. */
  readonly stack: string
}

/**
 * Formats a resource name in the standard `{project}-{stack}-{name}` shape, so
 * every stage is isolated inside a single AWS account by naming alone.
 *
 * The same string is used as both the Pulumi logical id and the physical
 * resource name, so the two can never drift apart.
 *
 * @example
 * getResourceIdentifier({ project: 'sisyphus', stack: 'staging' }, 'logs')
 * // → 'sisyphus-staging-logs'
 */
export const getResourceIdentifier = (scope: ResourceScope, name: string): string =>
  `${scope.project}-${scope.stack}-${name}`

// ---------------------------------------------------------------------------
// The scope every Sisyphus stack resolves resources under
// ---------------------------------------------------------------------------

/**
 * Project component of every resource name, identical across the three apps.
 *
 * Three separate SST apps deploy into one stage — the panel, the control plane
 * and the executor — and they must agree on the name of every resource they
 * share. `$app.name` cannot be that agreement: it differs per deployable by
 * definition.
 */
export const SISYPHUS_PROJECT = 'sisyphus'

/**
 * The scope a resource name is built under for an SST stage.
 *
 * The stack component is the **plain** stage, which is why `getPlainStage`
 * exists: `production`, `production-bootstrap` and `production-website` all name
 * the same buckets and the same database. The practical consequence is that only
 * one app creates a shared resource and the others derive its name from the same
 * helper, rather than each declaring its own.
 *
 * @example
 * getStackScope('production-bootstrap') // → { project: 'sisyphus', stack: 'production' }
 */
export const getStackScope = (sstStage: string): ResourceScope => {
  const stack = getPlainStage(sstStage)

  if (stack.trim() === '') {
    throw new Error('Cannot build a resource scope from an empty stage name')
  }

  return { project: SISYPHUS_PROJECT, stack }
}

// ---------------------------------------------------------------------------
// Names three stacks must agree on
// ---------------------------------------------------------------------------

/**
 * The bucket a class of object is stored in. The panel's stack creates them; the
 * control plane and the executor derive the same names from here, so no stack
 * can disagree with another about which bucket a workflow's logs are in.
 */
export const getBucketName = (scope: ResourceScope, objectClass: ObjectClass): string =>
  getResourceIdentifier(scope, objectClass)

/** Every bucket name for a stage, for a caller populating an environment. */
export const getBucketNames = (scope: ResourceScope): Readonly<Record<ObjectClass, string>> => ({
  artifacts: getBucketName(scope, 'artifacts'),
  bundles: getBucketName(scope, 'bundles'),
  logs: getBucketName(scope, 'logs'),
  snapshots: getBucketName(scope, 'snapshots'),
})

/**
 * The Secrets Manager name prefix a stage's agent credentials are stored under.
 *
 * One secret per agent credential is created beneath this prefix (research R8), so a rotation is
 * a `PutSecretValue` against a stable identifier rather than a rename. Derived from the plain
 * stage for the same reason bucket names are: the control plane writes these secrets and the
 * executor's instance profile is granted `secretsmanager:GetSecretValue` on the same prefix, and
 * neither stack may disagree with the other about where a stage's credentials live.
 *
 * Deliberately **not** shared across stages — a staging deploy must not be able to read a
 * production agent's login.
 *
 * @example
 * getAgentCredentialSecretPrefix({ project: 'sisyphus', stack: 'staging' })
 * // → 'sisyphus/staging/agent-credential'
 */
export const getAgentCredentialSecretPrefix = (scope: ResourceScope): string =>
  `${scope.project}/${scope.stack}/agent-credential`

/**
 * The Parameter Store path a stage's database connection URL is published to.
 *
 * Built from the plain stage so `<stage>-bootstrap` and `<stage>-website` read
 * and write the same entry. Publishing the URL to a parameter rather than
 * threading it through stack outputs is what keeps `sisyphus-api` the only
 * member that ever holds a database credential.
 */
export const getConnectionUrlParameterName = (stage: string): string =>
  `/sisyphus/${getPlainStage(stage)}/database/connection-url`

/**
 * The Parameter Store path every executor parameter for a stage hangs beneath.
 *
 * Three entries live here, written by two different stacks and read by two
 * different readers: `instance-profile-arn` and `release-key` and
 * `instance-environment` (the last two from `apps/sisyphus-executor/sst.config.ts`
 * and `executor-instance-environment.ts` respectively). The prefix is factored
 * out rather than restated at each leaf because it is not only a naming
 * convention — it is the **resource ARN the runner role's `ssm:GetParameter`
 * grant is scoped to** (`buildRunnerPolicy` in `policies.ts`, FR-075, FR-202).
 *
 * That makes a second spelling of this path an outright security defect rather
 * than an inconsistency: a leaf that drifted outside the prefix would deploy
 * cleanly, publish cleanly, and be unreadable by the one identity that exists to
 * read it — which is exactly the failure that left the release key unreadable
 * from the day the executor's stack was written. One string, one grant.
 *
 * Built from the plain stage, like every other path here, and **without** a
 * trailing slash so a caller composes `${prefix}/leaf`.
 *
 * @example
 * getExecutorParameterPathPrefix('production-bootstrap')
 * // → '/sisyphus/production/executor'
 */
export const getExecutorParameterPathPrefix = (stage: string): string =>
  `/sisyphus/${getPlainStage(stage)}/executor`

/**
 * The Parameter Store path the executor's instance profile ARN is published to.
 *
 * The executor's own stack creates the profile (fleet-wide today — see the
 * caveat on `createRunnerRole` in `runner-role.ts`) and publishes its ARN here.
 * The control plane reads it from here rather than from a copy in its own
 * operator-edited env blob, for the same reason it reads the database
 * connection URL from a published parameter instead of one: a stack that
 * recreates the profile must not leave every other deployable pointed at an ARN
 * that no longer exists. This means the executor's stack must be deployed
 * before the control plane's on a stage that has never seen either.
 */
export const getExecutorInstanceProfileParameterName = (stage: string): string =>
  `${getExecutorParameterPathPrefix(stage)}/instance-profile-arn`

/**
 * The Parameter Store paths the executor's public subnet and security-group
 * ids are published to.
 *
 * Same reasoning as {@link getExecutorInstanceProfileParameterName}, but this
 * time the panel's stack is the publisher: it creates the one shared VPC every
 * deployable's compute lives in (`createSisyphusVpc` in `vpc.ts`) alongside the
 * buckets and the database, and the control plane reads the executor's public
 * subnet ids and executor security group id from here rather than from a value
 * an operator typed once. Each parameter holds a comma-separated list, in the
 * same shape `SISYPHUS_EXECUTOR_SUBNET_IDS` and
 * `SISYPHUS_EXECUTOR_SECURITY_GROUP_IDS` already take at runtime.
 */
export const getExecutorSubnetIdsParameterName = (stage: string): string =>
  `/sisyphus/${getPlainStage(stage)}/executor/subnet-ids`

export const getExecutorSecurityGroupIdsParameterName = (stage: string): string =>
  `/sisyphus/${getPlainStage(stage)}/executor/security-group-ids`

/**
 * The Parameter Store paths the shared VPC's **private** subnet ids and app
 * security group id are published to — what a VPC-attached Lambda needs, as
 * opposed to {@link getExecutorSubnetIdsParameterName}'s public subnets for the
 * executor's EC2 instances.
 *
 * The panel's own server function reads these to attach itself; the control
 * plane's Lambda reads the same two parameters for the same reason: both have
 * to be inside the VPC to reach the database, and both have to share one app
 * security group, because the database's own security group admits exactly
 * that one group and no other (`createSisyphusVpc` in `vpc.ts`).
 */
export const getAppSubnetIdsParameterName = (stage: string): string =>
  `/sisyphus/${getPlainStage(stage)}/app/subnet-ids`

export const getAppSecurityGroupIdParameterName = (stage: string): string =>
  `/sisyphus/${getPlainStage(stage)}/app/security-group-id`

// ---------------------------------------------------------------------------
// Deploy-time environment values
// ---------------------------------------------------------------------------

/**
 * The single function `getEnvSecret` needs in order to wrap a value: `$util.secret`
 * at a deploy-time call site, and the identity function where a value must stay
 * legible. It is a formatting choice about one string, not a stand-in for a
 * resource constructor.
 */
export interface SecretWrapper<TSecret> {
  (value: string): TSecret
}

export interface GetEnvSecretOptions {
  /**
   * Return the raw string rather than a wrapped secret. Reserved for the
   * bootstrap-time values that cannot be secrets, because they are needed in
   * order to deploy at all.
   */
  readonly dangerousClearText?: boolean
}

/**
 * Narrows a process environment to a total record of the values that are
 * actually set.
 *
 * `process.env` types every value as possibly `undefined`, which
 * {@link getEnvSecret} cannot consume — and quietly treating an unset variable
 * as an empty string is exactly the failure `getEnvSecret` exists to prevent.
 * Dropping unset keys here means the variable is missing from the record, so the
 * error names it.
 */
export const readEnvRecord = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  )

  return Object.fromEntries(entries)
}

/**
 * Reads a deploy-time value out of an environment record, wrapping it as a
 * Pulumi secret by default so it does not appear in plain text in stack state.
 *
 * Throws naming the missing variable rather than letting an empty string reach
 * a resource argument, which is the deploy-time counterpart of what
 * `createSafeEnv` does at boot.
 */
export const getEnvSecret = <TSecret, TSecrets extends Record<string, string>>(
  wrapSecret: SecretWrapper<TSecret>,
  secrets: TSecrets,
  key: keyof TSecrets,
  options: GetEnvSecretOptions = {},
): TSecret | string => {
  const value = secrets[key]

  if (!value) {
    throw new Error(`Missing environment variable: ${String(key)}`)
  }

  return options.dangerousClearText === true ? value : wrapSecret(value)
}

// ---------------------------------------------------------------------------
// IAM policy documents, as plain data
// ---------------------------------------------------------------------------

/**
 * IAM policy documents are expressed as plain, serialisable data with AWS's own
 * PascalCase keys. Every identifier is a plain `string`: a caller holding an
 * unresolved output resolves it with `.apply()` before calling a builder, which
 * keeps these types free of any provider generic and keeps the builders in
 * `policies.ts` pure and directly assertable.
 */
export interface PolicyPrincipal {
  readonly Federated?: readonly string[]
  readonly Service?: readonly string[]
}

export type PolicyConditionOperator = Readonly<Record<string, readonly string[] | string>>

export interface PolicyStatement {
  readonly Sid?: string
  readonly Effect: 'Allow' | 'Deny'
  readonly Principal?: PolicyPrincipal
  readonly Action: readonly string[]
  readonly Resource?: readonly string[]
  readonly Condition?: Readonly<Record<string, PolicyConditionOperator>>
}

export interface PolicyDocument {
  readonly Version: '2012-10-17'
  readonly Statement: readonly PolicyStatement[]
}

/** The only IAM policy language version AWS accepts for new policies. */
export const POLICY_VERSION = '2012-10-17' as const
