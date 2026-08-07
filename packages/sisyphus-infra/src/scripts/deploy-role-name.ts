/**
 * The CI deploy role's name, in one place.
 *
 * The role is *created* by the bootstrap config and its identifier is *rebuilt*
 * by the CI deploy script, which never sees the created resource. Those are two
 * different programs deriving one AWS name, and the failure mode is silent: two
 * string literals that agree today drift tomorrow, and the deploy fails with
 * "role not found" — or, worse, assumes a stale role that still exists and still
 * has AdministratorAccess. FR-200 requires the shared part to be one exported
 * constant used by both, so this module is the only place the word appears.
 *
 * Nothing here touches AWS or reads the environment; it is string arithmetic
 * over the same `getResourceIdentifier` every other resource name goes through,
 * so the role sorts and scopes exactly like the rest of the stage.
 */

import { getResourceIdentifier, type ResourceScope } from '../lib'

/**
 * The name component appended to the stage scope. Not a full role name on its
 * own — {@link getDeployRoleName} composes it.
 */
export const DEPLOY_ROLE_NAME = 'deploy'

/**
 * The deploy role's physical IAM name for a stage.
 *
 * @example
 * getDeployRoleName({ project: 'sisyphus', stack: 'production' })
 * // → 'sisyphus-production-deploy'
 */
export const getDeployRoleName = (scope: ResourceScope): string =>
  getResourceIdentifier(scope, DEPLOY_ROLE_NAME)

/**
 * The deploy role's ARN, composed rather than read back from the resource — the
 * CI script assumes the role before any stack state is readable, so it cannot
 * look the ARN up.
 *
 * @example
 * getDeployRoleArn('123456789012', { project: 'sisyphus', stack: 'staging' })
 * // → 'arn:aws:iam::123456789012:role/sisyphus-staging-deploy'
 */
export const getDeployRoleArn = (accountId: string, scope: ResourceScope): string =>
  `arn:aws:iam::${accountId}:role/${getDeployRoleName(scope)}`
