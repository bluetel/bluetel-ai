import { describe, expect, it } from 'vitest'

import { omitReservedLambdaEnv } from './reserved-lambda-env'

describe('omitReservedLambdaEnv', () => {
  it('drops AWS_REGION', () => {
    expect(omitReservedLambdaEnv({ AWS_REGION: 'eu-west-2', SISYPHUS_STAGE: 'staging' })).toEqual({
      SISYPHUS_STAGE: 'staging',
    })
  })

  it('leaves an environment with no reserved key untouched', () => {
    const environment = { SISYPHUS_STAGE: 'staging', DATABASE_URL: 'postgres://x' }

    expect(omitReservedLambdaEnv(environment)).toEqual(environment)
  })

  it('handles an empty environment', () => {
    expect(omitReservedLambdaEnv({})).toEqual({})
  })
})
