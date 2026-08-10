import type { Workflow } from '@bluetel-ai/sisyphus-api/db'
import { terminalOutcomeEnum } from '@bluetel-ai/sisyphus-api/db'

/**
 * The one rule that decides whether a run still owns its seat (FR-019, FR-073, T047, T049).
 *
 * FR-019 is written as a prohibition — a lease is released **only** on terminal state or on an
 * administrator's force-release, and never on a pause, a park, or the destruction of an execution
 * environment — and a prohibition is exactly the kind of rule that decays when it is restated. It
 * has three call sites in this directory: teardown hands the seat back when a run finishes,
 * admission hands one back when the run it reserved for was cancelled underneath it, and the FR-022
 * sweep hands back the ones nobody is left to hand back. Three copies of the same conditional is
 * three places for the park case to be forgotten, and the cost of forgetting it once is a running
 * agent losing its identity mid-run.
 *
 * ## Why `parked_resumable` is the whole reason this module exists
 *
 * Pause is easy: a `paused` run is not terminal, so every terminal-gated path already declines to
 * touch it, and `teardown-workflow.ts` returns `not_terminal` before it reaches anything.
 *
 * Park is not. `parked_resumable` is a member of `TERMINAL_OUTCOMES` — deliberately, so FR-064's
 * "exactly one outcome in force" and SC-006's clocks both hold — which means every `isTerminal`
 * check in this directory answers **true** for a parked run, and every one of them is right to.
 * Parking really does release the run's compute: that is the difference between parking and
 * pausing. It does **not** release the run's seat. FR-073 says so directly ("a parked workflow MUST
 * retain its agent credential, and MUST release it when it becomes terminal"), and SC-018 depends
 * on it: a run that resumed from a park onto a different identity would be one workflow spanning
 * two agents, which is the single thing this feature exists to make impossible.
 *
 * So "terminal" and "hands its seat back" are two different questions with two different answers,
 * and this module is the second one. {@link isTerminalWorkflowState} stays available for the first,
 * because the compute paths genuinely do want it.
 *
 * ## Environment destruction reaches none of this
 *
 * There is no state for it and there does not need to be one. A lease belongs to the workflow and
 * not to any instance (FR-018), so an environment being stopped, reclaimed or rebuilt changes no
 * `workflows.state` at all — and a rule that reads only the run's state therefore cannot be
 * triggered by one. That is why the rule is expressed over the state rather than over the event
 * that prompted the check.
 */

/**
 * The one terminal outcome that keeps its seat.
 *
 * Named rather than written as a literal at each call site, so a reader who finds a comparison
 * against it lands here and not on a guess about why one outcome is special.
 */
export const AGENT_CREDENTIAL_RETAINING_OUTCOME = 'parked_resumable'

/**
 * Whether a run has finished.
 *
 * Read off `terminalOutcomeEnum` rather than from a list restated here: the FR-064 outcome names
 * double as states so `workflows.state` and `workflows.terminal_outcome` cannot disagree, and
 * deriving this from the same enum the column is typed by means a seventh outcome is understood
 * the day it is added.
 *
 * @param state - The run's current state.
 */
export const isTerminalWorkflowState = (state: Workflow['state']): boolean =>
  (terminalOutcomeEnum.enumValues as readonly string[]).includes(state)

/**
 * Whether a run in this state has given up its claim on an agent credential.
 *
 * The safe direction is the strict one, and it falls out of the shape: an unrecognised or newly
 * added state is not in `terminalOutcomeEnum`, so it answers `false` and the seat stays where it
 * is. A seat held a little too long is capacity an administrator can see and force-release
 * (FR-057); a seat taken from a live run is an agent losing its identity mid-run, with no
 * corresponding way back.
 *
 * @param state - The run's current state.
 * @returns `true` only for a terminal run that is not merely parked.
 */
export const releasesAgentCredential = (state: Workflow['state']): boolean =>
  isTerminalWorkflowState(state) && state !== AGENT_CREDENTIAL_RETAINING_OUTCOME
