import { describe, expect, it } from 'vitest'

import {
  DEFAULT_AWS_REGION,
  DEPLOY_STAGES,
  PRODUCTION_STAGE,
  getStageRemoval,
  isDeployStage,
  isProductionStage,
} from './sst-app'

describe('isDeployStage', () => {
  it('recognises only the two branch-gated stages', () => {
    expect(DEPLOY_STAGES).toEqual(['production', 'staging'])
    expect(isDeployStage('production')).toBe(true)
    expect(isDeployStage('staging')).toBe(true)
    expect(isDeployStage('harry')).toBe(false)
    expect(isDeployStage('production-bootstrap')).toBe(false)
  })
})

describe('isProductionStage', () => {
  it('answers for the plain stage, so an auxiliary stage is production too', () => {
    expect(isProductionStage(PRODUCTION_STAGE)).toBe(true)
    expect(isProductionStage('production-bootstrap')).toBe(true)
    expect(isProductionStage('production-website')).toBe(true)
    expect(isProductionStage('staging')).toBe(false)
    expect(isProductionStage('production-like')).toBe(false)
  })
})

describe('getStageRemoval', () => {
  it('retains a deploy stage and removes a personal one', () => {
    expect(getStageRemoval('production').removal).toBe('retain')
    expect(getStageRemoval('staging').removal).toBe('retain')
    expect(getStageRemoval('harry').removal).toBe('remove')
  })

  it('protects production alone', () => {
    expect(getStageRemoval('production').protect).toBe(true)
    expect(getStageRemoval('staging').protect).toBe(false)
    expect(getStageRemoval('harry').protect).toBe(false)
  })

  it('decides from the plain stage, so an auxiliary stage is as protected as its parent', () => {
    expect(getStageRemoval('production-bootstrap')).toEqual({ removal: 'retain', protect: true })
    expect(getStageRemoval('production-website')).toEqual({ removal: 'retain', protect: true })
  })

  it('gives the same answer wherever it is asked, which is why it is one function', () => {
    expect(getStageRemoval('staging-website')).toEqual(getStageRemoval('staging-bootstrap'))
    expect(getStageRemoval('staging-website')).toEqual(getStageRemoval('staging'))
  })
})

describe('DEFAULT_AWS_REGION', () => {
  it('matches the region the deploy workflow falls back to', () => {
    expect(DEFAULT_AWS_REGION).toBe('eu-west-2')
  })
})
