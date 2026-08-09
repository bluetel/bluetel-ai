// @bluetel-ai/sisyphus-infra
// Shared, app-agnostic infrastructure constructs. Consumed only by the
// deployables' deployment config files — never imported at runtime.
//
// ---------------------------------------------------------------------------
// The shape of a construct, and why the tests are where they are
// ---------------------------------------------------------------------------
// A construct here is a plain function, `createX(config)`, that instantiates
// `sst.aws.*` / `aws.*` resources **directly** and returns what it created. It
// takes no provider, no constructor and no factory: providers are configured
// once in the deployable's `app()` and inherited implicitly, and composition
// happens by passing already-created resource handles between constructs
// (FR-066). There is nothing standing between the function and the resource.
//
// Those constructs carry no unit tests, on purpose. A test that asserts a fake
// constructor was called with the arguments just handed to it restates the
// implementation, breaks on rename, and catches no defect a deploy would not.
// Verifying a construct is the deployment's job.
//
// What is worth asserting is separated out and tested directly, because a
// mistake in it is a security or retention defect that deploys perfectly well
// and reports nothing (FR-200):
//
//   lib.ts                          resource naming, the stage scope, the
//                                   parameter path, and the policy-document shape
//   get-plain-stage.ts              the stage-suffix derivation everything routes through
//   sst-app.ts                      the deploy-stage set and the teardown decision
//   retention.ts                    days, transitions and lifecycle rules per object class
//   policies.ts                     every IAM document, and the exact trusted OIDC subject
//   schedule-name.ts                schedule naming, including the collision refusal
//   missing-oidc-provider-message.ts the diagnostic FR-068 requires when the provider is absent
//   panel-domain.ts                 the panel's domain per stage, and the refusal that confines
//                                   what it may create in the shared `bluetel.co.uk` zone
//
// A construct reads its values from those modules and never restates one.

export {
  POLICY_VERSION,
  SISYPHUS_PROJECT,
  getAppSecurityGroupIdParameterName,
  getAppSubnetIdsParameterName,
  getBucketName,
  getBucketNames,
  getConnectionUrlParameterName,
  getEnvSecret,
  getExecutorInstanceProfileParameterName,
  getExecutorSecurityGroupIdsParameterName,
  getExecutorSubnetIdsParameterName,
  getResourceIdentifier,
  getStackScope,
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

export {
  DEFAULT_AWS_REGION,
  DEPLOY_STAGES,
  PRODUCTION_STAGE,
  getStageRemoval,
  isDeployStage,
  isProductionStage,
  type DeployStage,
  type SstRemovalPolicy,
  type StageRemoval,
} from './sst-app'

export {
  ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS,
  DEFAULT_INFREQUENT_ACCESS_DAYS,
  DEFAULT_RETENTION_DAYS,
  OBJECT_CLASSES,
  VERSIONED_OBJECT_CLASSES,
  WORKFLOW_PARTITION_PREFIX,
  buildLifecycleRule,
  getLifecycleTransitions,
  getObjectExpiresAt,
  getRetentionDays,
  getWorkflowObjectPrefix,
  hasObjectExpired,
  isVersionedObjectClass,
  type LifecycleRule,
  type LifecycleTransition,
  type ObjectClass,
  type RetentionConfig,
  type StorageClass,
} from './retention'

export {
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_CLAIM_PREFIX,
  GITHUB_OIDC_ISSUER_URL,
  GITHUB_OIDC_THUMBPRINTS,
  buildControlPlanePolicy,
  buildDeployRoleTrustPolicy,
  buildPanelBundlesPolicy,
  buildRunnerPolicy,
  buildRunnerTrustPolicy,
  getDeployBranchRef,
  getTrustedSubject,
  type ControlPlanePolicyConfig,
  type DeployRoleTrustPolicyConfig,
  type PanelBundlesPolicyConfig,
  type RunnerPolicyConfig,
} from './policies'

export { getMissingOidcProviderMessage } from './missing-oidc-provider-message'

export { RESERVED_LAMBDA_ENV_KEYS, omitReservedLambdaEnv } from './reserved-lambda-env'

export {
  getControlPlaneTickName,
  getIntegrationScheduleName,
  getSchedulerGroupName,
  toScheduleName,
} from './schedule-name'

export {
  BUCKET_SERVER_SIDE_ENCRYPTION,
  createBuckets,
  type Buckets,
  type BucketsConfig,
} from './buckets'

export { createDatabase, type Database, type DatabaseConfig } from './database'

export { createOidcProvider, type OidcProviderConfig } from './oidc-provider'

export {
  EXECUTOR_RUNNER_ROLE_NAME,
  createRunnerRole,
  type RunnerRole,
  type RunnerRoleConfig,
} from './runner-role'

export { SISYPHUS_VPC_NAME, createSisyphusVpc, type SisyphusVpc } from './vpc'

export {
  CONTROL_PLANE_TICK_JOB,
  createScheduler,
  type ScheduleTargetConfig,
  type Scheduler,
  type SchedulerConfig,
} from './scheduler'

export {
  NEXTJS_WEBSITE_NAME,
  createNextjsWebsite,
  type NextjsWebsiteConfig,
} from './nextjs-website'

export {
  PANEL_DNS_ZONE_NAME,
  PANEL_DOMAIN_ROOT,
  assertPanelDnsZone,
  getMissingPanelDnsZoneMessage,
  getPanelDomain,
  getPanelUrl,
  isPanelDnsName,
  type PanelDnsZoneAssertion,
} from './panel-domain'

export { createPanelDomain, type PanelDomainConfig } from './panel-dns'
