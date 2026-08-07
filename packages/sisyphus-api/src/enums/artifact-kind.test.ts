import { describe, expect, it } from 'vitest'

import { ARTIFACT_KINDS, isArtifactKind } from './artifact-kind'

describe('ARTIFACT_KINDS', () => {
  it('names what a run leaves behind', () => {
    expect([...ARTIFACT_KINDS]).toStrictEqual(['pull_request', 'diff', 'report', 'attachment'])
  })

  it('guards membership', () => {
    expect(isArtifactKind('pull_request')).toBe(true)
    expect(isArtifactKind('commit')).toBe(false)
  })
})
