// @bluetel-ai/sisyphus-infra
// Shared, app-agnostic SST/Pulumi infrastructure primitives. Consumed only by
// the deployables' `sst.config.ts` files — never imported at runtime.
//
// ---------------------------------------------------------------------------
// Why nothing here imports SST
// ---------------------------------------------------------------------------
// SST v3's `sst.aws.*` globals are only typed inside a project that has a
// generated `.sst/platform/config.d.ts`. This package has no such file and must
// not need one: it has to typecheck and unit-test on its own, in CI, with no
// cloud credentials and no `sst install` step ahead of it. A primitive that
// reached for `sst.aws.Bucket` directly would drag SST's type generation into
// `nx affected -t typecheck`, and would only be testable by deploying.
//
// So every primitive is a **factory taking the provider surface it needs as a
// narrow, locally-declared structural interface**, returning the resource
// specification alongside whatever the provider gave back. `sst.config.ts`
// passes in constructors closing over the real `sst`/`aws` globals (T137); a
// test passes in a recording fake.
//
// The pure part — names, retention schedules, IAM policy documents, the exact
// GitHub OIDC `sub` claim — is separated into `build*` functions taking no
// provider at all, because those are the parts where a mistake is a security or
// data-retention defect rather than a deploy failure, and they deserve to be
// asserted directly.

export {
  POLICY_VERSION,
  getEnvSecret,
  getResourceIdentifier,
  readEnvRecord,
  type GetEnvSecretOptions,
  type PolicyConditionOperator,
  type PolicyDocument,
  type PolicyPrincipal,
  type PolicyStatement,
  type ResourceScope,
  type SecretWrapper,
} from './lib'

export {
  BOOTSTRAP_STAGE_SUFFIX,
  WEBSITE_STAGE_SUFFIX,
  getPlainStage,
  isBootstrapStage,
} from './get-plain-stage'

export { SISYPHUS_PROJECT, getStackScope } from './stack-scope'

export {
  DEFAULT_AWS_REGION,
  DEPLOY_STAGES,
  buildSstApp,
  isDeployStage,
  type DeployStage,
  type SstAppConfig,
  type SstAppInput,
  type SstAppOptions,
  type SstConfigDefinition,
  type SstRemovalPolicy,
} from './sst-app'

export {
  DEFAULT_INFREQUENT_ACCESS_DAYS,
  DEFAULT_RETENTION_DAYS,
  buildBucketSpecifications,
  createBuckets,
  getObjectExpiresAt,
  getRetentionDays,
  getWorkflowObjectPrefix,
  hasObjectExpired,
  type BucketLifecycleRule,
  type BucketLifecycleTransition,
  type BucketObjectClass,
  type BucketProvider,
  type BucketSpecification,
  type BucketSpecifications,
  type BucketStorageClass,
  type BucketsConfig,
  type CreatedBucket,
  type CreatedBuckets,
} from './buckets'

export {
  buildDatabaseSpecification,
  createDatabase,
  getConnectionUrlParameterName,
  type CreatedDatabase,
  type DatabaseConfig,
  type DatabaseProvider,
  type DatabaseSpecification,
  type ParameterSpecification,
} from './database'

export {
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_ISSUER_URL,
  GITHUB_OIDC_THUMBPRINTS,
  buildDeployRoleTrustPolicy,
  buildOidcProviderSpecification,
  getDeployBranchRef,
  getMissingOidcProviderMessage,
  getTrustedSubject,
  resolveOidcProviderArn,
  type DeployRoleTrustPolicyConfig,
  type OidcProviderConfig,
  type OidcProviderSpecification,
  type OidcProviderSurface,
} from './oidc-provider'

export {
  buildRunnerPolicy,
  buildRunnerRoleSpecification,
  buildRunnerTrustPolicy,
  createRunnerRole,
  type CreatedRunnerRole,
  type RunnerRoleConfig,
  type RunnerRoleProvider,
  type RunnerRoleSpecification,
} from './runner-role'

export {
  buildControlPlaneTickSpecification,
  buildIntegrationScheduleName,
  buildIntegrationScheduleSpecification,
  buildSchedulerGroupSpecification,
  createScheduler,
  toScheduleName,
  type ControlPlaneTickConfig,
  type CreatedScheduler,
  type IntegrationScheduleConfig,
  type ScheduleSpecification,
  type ScheduleTarget,
  type ScheduleTargetConfig,
  type SchedulerGroupSpecification,
  type SchedulerProvider,
} from './scheduler'
