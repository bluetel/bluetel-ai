import { describe, expect, it } from 'vitest'

import { ENTRY_RESULTS, isEntryResult } from './entry-result'

describe('ENTRY_RESULTS', () => {
  it('records a repository that needed no edit as its own result, not as a failure (FR-114)', () => {
    expect([...ENTRY_RESULTS]).toStrictEqual(['unchanged', 'landed', 'failed'])
    expect(ENTRY_RESULTS).toContain('unchanged')
  })

  it('guards membership', () => {
    expect(isEntryResult('landed')).toBe(true)
    expect(isEntryResult('skipped')).toBe(false)
  })
})
