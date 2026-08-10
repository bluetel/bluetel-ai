import { terminalOutcomeEnum, workflowStateEnum } from '@bluetel-ai/sisyphus-api/db'
import { describe, expect, it } from 'vitest'

import {
  AGENT_CREDENTIAL_RETAINING_OUTCOME,
  isTerminalWorkflowState,
  releasesAgentCredential,
} from './agent-credential-release'

/**
 * The tests that earn their place here are the three negatives. FR-019 is a prohibition, and a
 * prohibition is only tested by the cases it forbids: pause, park, and every state a run passes
 * through while it is alive.
 *
 * The list is enumerated from the Postgres enums rather than written out, so a state added to the
 * platform tomorrow is covered by these assertions on the day it is added rather than on the day
 * somebody remembers this file.
 */
describe('which states hand an agent credential back', () => {
  it('releases on every terminal outcome except a park (FR-019, FR-073)', () => {
    const releasing = terminalOutcomeEnum.enumValues.filter((outcome) =>
      releasesAgentCredential(outcome),
    )

    expect(releasing).toStrictEqual(
      terminalOutcomeEnum.enumValues.filter(
        (outcome) => outcome !== AGENT_CREDENTIAL_RETAINING_OUTCOME,
      ),
    )
  })

  it('retains the seat of a parked run, which is terminal and still holding it (FR-073, SC-018)', () => {
    // The load-bearing asymmetry: park *is* terminal — parking releases compute — and it is
    // nevertheless the one terminal outcome that keeps its credential, because FR-151 resumes the
    // same workflow out of it and SC-018 says one workflow is performed by exactly one identity.
    expect(isTerminalWorkflowState('parked_resumable')).toBe(true)
    expect(releasesAgentCredential('parked_resumable')).toBe(false)
  })

  it('retains the seat through a pause, which is not terminal at all (FR-019)', () => {
    expect(isTerminalWorkflowState('paused')).toBe(false)
    expect(releasesAgentCredential('paused')).toBe(false)
  })

  it('retains the seat in every state a live run can be in, including the ones that hold no compute', () => {
    // `awaiting_credential` matters here: a run that has just been granted a seat by the queue has
    // a live lease and a state that is not yet `provisioning`, and a sweep that read "not running"
    // as "not holding" would take the seat back before the grant had finished landing.
    const live = workflowStateEnum.enumValues.filter((state) => !isTerminalWorkflowState(state))

    expect(live).toContain('awaiting_credential')
    for (const state of live) {
      expect(releasesAgentCredential(state)).toBe(false)
    }
  })

  it('treats a state it has never heard of as one that still holds its seat', () => {
    // The safe direction. An unrecognised state is not in the terminal enum, so the rule declines
    // to act rather than guessing — a seat held too long is visible and force-releasable, and a
    // seat taken from a live run is an agent losing its identity with no way back.
    expect(releasesAgentCredential('a_state_that_does_not_exist' as never)).toBe(false)
  })
})
