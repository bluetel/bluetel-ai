import { describe, expect, it } from 'vitest'

import * as entryResults from './index'

describe('the entry-results barrel', () => {
  it('exports the card and the shaping behind it', () => {
    expect(typeof entryResults.EntryResultsCard).toBe('function')
    expect(typeof entryResults.toEntryResultsReadouts).toBe('function')
  })

  it('exports nothing that would act on a run', () => {
    // The panel reports what happened across the repositories; what to do about one that did not
    // land belongs to that repository's own skills (FR-079).
    expect(
      Object.keys(entryResults).filter((name) => /retry|rebase|merge|close|reopen/i.test(name)),
    ).toEqual([])
  })
})
