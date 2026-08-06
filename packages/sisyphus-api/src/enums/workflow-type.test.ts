import { describe, expect, it } from 'vitest'

import { isWorkflowType, WORKFLOW_TYPES } from './workflow-type'

describe('WORKFLOW_TYPES', () => {
  it('is the data-model set, in order', () => {
    expect([...WORKFLOW_TYPES]).toStrictEqual(['delegated', 'autonomous', 'review'])
  })

  it('holds no duplicates', () => {
    expect(new Set(WORKFLOW_TYPES).size).toBe(WORKFLOW_TYPES.length)
  })

  it('guards membership', () => {
    expect(isWorkflowType('autonomous')).toBe(true)
    expect(isWorkflowType('supervised')).toBe(false)
  })
})
