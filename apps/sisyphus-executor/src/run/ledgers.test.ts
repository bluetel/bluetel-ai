import { describe, expect, it } from 'vitest'

import type { ExternalActionRecorder } from '../delivery'

import { createRunExternalActionLedgers } from './ledgers'

/**
 * One assertion carries this module: every ledger a run is handed is durable. The whole point of
 * building them in one place is that "durable or not" stops being a per-call-site decision, and a
 * test that only checked the shape would keep passing after somebody dropped the recorder.
 */

const recorder: ExternalActionRecorder = {
  reportExternalAction: () =>
    Promise.resolve({ action: {} as never, claimed: true, alreadyPerformed: false }),
}

describe('the run’s external-action ledgers', () => {
  it('are every one of them backed by the durable claim (FR-076)', () => {
    const ledgers = createRunExternalActionLedgers(recorder)

    expect(
      Object.values(ledgers).map((ledger: { readonly isDurable: boolean }) => ledger.isDurable),
    ).toStrictEqual([true, true, true, true])
  })

  it('keeps one per delivery step, so a replay hands back the right kind of result', () => {
    expect(Object.keys(createRunExternalActionLedgers(recorder)).sort()).toStrictEqual([
      'integration',
      'pullRequest',
      'reviewComment',
      'ticket',
    ])
  })
})
