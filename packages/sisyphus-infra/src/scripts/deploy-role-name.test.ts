import { describe, expect, it } from 'vitest'

import { getStackScope } from '../lib'

import { DEPLOY_ROLE_NAME, getDeployRoleArn, getDeployRoleName } from './deploy-role-name'

describe('getDeployRoleName', () => {
  it('names the role under the stage scope', () => {
    expect(getDeployRoleName({ project: 'sisyphus', stack: 'production' })).toBe(
      'sisyphus-production-deploy',
    )
  })

  /**
   * The bootstrap deploys to `<stage>-bootstrap` and the CI script only knows
   * the plain stage. Both resolve their scope through `getStackScope`, so both
   * must land on the same name — this is the drift the module exists to stop.
   */
  it('resolves to one name from the bootstrap stage and from the plain stage', () => {
    expect(getDeployRoleName(getStackScope('production-bootstrap'))).toBe(
      getDeployRoleName(getStackScope('production')),
    )
  })

  it('keeps stages apart', () => {
    expect(getDeployRoleName(getStackScope('staging'))).not.toBe(
      getDeployRoleName(getStackScope('production')),
    )
  })
})

describe('getDeployRoleArn', () => {
  it('composes the ARN from the account and the role name', () => {
    expect(getDeployRoleArn('123456789012', { project: 'sisyphus', stack: 'staging' })).toBe(
      'arn:aws:iam::123456789012:role/sisyphus-staging-deploy',
    )
  })

  it('ends with the same name the bootstrap creates', () => {
    const scope = getStackScope('production')

    expect(getDeployRoleArn('123456789012', scope).endsWith(`/${getDeployRoleName(scope)}`)).toBe(
      true,
    )
  })
})

describe('DEPLOY_ROLE_NAME', () => {
  it('is the suffix every derived identifier ends with', () => {
    expect(getDeployRoleName(getStackScope('staging')).endsWith(DEPLOY_ROLE_NAME)).toBe(true)
  })
})
