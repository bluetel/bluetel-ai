import { describe, expect, it } from 'vitest'

import { parseInstanceTag, validationInstanceTag, workflowInstanceTag } from './instance-tag'

/**
 * The tag is the only thing the reconciler has to go on when it meets an instance the database has
 * never heard of, so the property that matters is that the two run kinds are **distinguishable** —
 * not merely different in some other table.
 */

describe('instance tags', () => {
  it('tags a workflow instance with the workflow id alone', () => {
    expect(workflowInstanceTag('abc')).toBe('abc')
    expect(parseInstanceTag(workflowInstanceTag('abc'))).toStrictEqual({
      kind: 'workflow',
      id: 'abc',
    })
  })

  it('tags a validation instance in a space of its own', () => {
    expect(validationInstanceTag('abc')).toBe('validation:abc')
    expect(parseInstanceTag(validationInstanceTag('abc'))).toStrictEqual({
      kind: 'validation',
      id: 'abc',
    })
  })

  it('keeps the two apart even when the underlying ids are identical', () => {
    // The failure this prevents: the sweep looking a validation run's id up in `workflows`,
    // finding nothing, and destroying a healthy instance halfway through `setup.sh`.
    const id = '33333333-3333-3333-3333-333333333333'

    expect(parseInstanceTag(workflowInstanceTag(id)).kind).toBe('workflow')
    expect(parseInstanceTag(validationInstanceTag(id)).kind).toBe('validation')
  })

  it('reports an absent, empty or prefix-only tag as unattributed', () => {
    for (const value of [undefined, '', 'validation:']) {
      expect(parseInstanceTag(value)).toStrictEqual({ kind: 'unattributed', id: undefined })
    }
  })
})
