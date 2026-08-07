// @bluetel-ai/sisyphus-infra/scripts
//
// The deploy-time and CI-time helpers, kept behind their own subpath because
// they are the only part of this package that talks to AWS at *run* time rather
// than describing what AWS should contain (FR-200).
//
// Two consumers share this surface and must not disagree with each other:
//
//   the bootstrap config   creates the deploy role and the configuration entry
//   the CI deploy script   rebuilds that role's ARN and reads that entry
//
// Neither can see the other's resources, so every name they share comes from one
// exported constant here. Nothing in this subpath executes at import time — no
// AWS client is constructed, no environment variable is read — because a
// deployment config imports it in a process that may have no credentials at all.

export { DEPLOY_ROLE_NAME, getDeployRoleArn, getDeployRoleName } from './deploy-role-name'

export {
  DEPLOYABLE_KEYS,
  getDeploymentEnvironment,
  getEnvParameterName,
  parseEnvContent,
  type DeployableKey,
  type DeploymentEnvironmentOptions,
} from './get-deployment-environment'

export {
  applyEnvContent,
  assumeAwsRoleWithOidc,
  assumeDeployRole,
  fetchCallerAccountId,
  fetchGitHubOidcToken,
  fetchSsmParamToEnvFile,
  fetchSsmParamToProcessEnv,
  formatEnvFile,
  type AssumeDeployRoleOptions,
  type AwsCredentials,
} from './ci-deploy-utils'
