import type { WorkflowState } from '@bluetel-ai/sisyphus-api/client'
import { credentialWaitDetail } from '@bluetel-ai/sisyphus-api/client'
import { formatElapsed } from '@sisyphus-admin/components/admin'

import type { TimelineItem } from './workflow-detail-readouts'

/**
 * **Saying that a run is waiting for an agent credential, and for how long** (T070, 003/SC-006).
 *
 * SC-006 is written as a test of this screen: *an engineer can tell, from the workflow view alone
 * and without assistance, that a run is waiting for an agent credential and how long it has
 * waited*. "Without assistance" is the operative phrase — if the answer requires asking somebody
 * which pool the run draws on, or reading a control-plane log, the criterion is not met.
 *
 * The state chip alone does not meet it. `awaiting_credential` presents as **awaiting agent
 * credential** (see `components/ui/workflow-state-presentation.ts`), which says the run is waiting
 * and nothing about why or for how long — and 003/FR-029 exists precisely because "no capacity" is
 * an answer nobody can act on. The four situations that produce it have four different remedies:
 * every seat held (wait, or add capacity), every seat cooling off (wait; it clears itself), every
 * seat unhealthy or disabled (an administrator must act), and **the attached groups holding no
 * credentials at all** — which is not a wait but a configuration fault, and is the one an engineer
 * must not be left waiting out.
 *
 * ## Why this is derived from the timeline rather than from a field on the run
 *
 * The control plane records the wait as a `queued` timeline entry carrying `credentialWaitDetail`
 * when it moves the run into the state, and that entry is the whole source here: the timestamp is
 * when the wait began, and the detail is the classification. The detail panel already reads the
 * timeline, so this costs no extra request — and there is no `awaiting_credential_since` column to
 * disagree with, which is the failure such pairs eventually produce.
 *
 * The detail is **parsed** rather than cast. `workflow_events.detail` is `jsonb`, so what arrives
 * is `unknown`, and a panel one release ahead of the control plane will meet rows written by the
 * older one. A row that will not parse produces no readout at all rather than a card with empty
 * sentences in it.
 *
 * ## Why the `queued` event name is not enough on its own
 *
 * `queued` also means "waiting under the FR-040 concurrency ceiling" — a different scarcity with a
 * different remedy — so every entry is matched on the `waitingOn` discriminator inside the detail,
 * never on the event name. A reader that matched the name would time a credential wait from the
 * moment the run was created and tell an engineer their four-second wait was an hour old.
 *
 * ## Why a past wait is still reported, and how its end is known
 *
 * A run that waited twenty minutes and then started is a run whose lateness has an explanation, and
 * an engineer looking at it afterwards deserves the explanation rather than an unexplained gap. The
 * end of the wait is **derived**, not reported: the next timeline entry after the wait is the run
 * leaving it — admission's `admitted`, or the expiry's `failed`. Nothing writes a "wait ended"
 * event, and nothing should, because the one moment it would have to be written is the moment the
 * run is being handed on to something else. `storage-park.ts` makes the same argument at length.
 *
 * ## What it deliberately does not do
 *
 * It raises nothing. 003/FR-079 keeps waiting, cooling off and parking off the notification path
 * entirely — they are reported in the workflow view and nowhere else — and `sisyphus-notify` maps
 * `awaiting_credential` to no event, which is what makes that true rather than merely intended.
 * This module reads the timeline and returns strings; it has no way to reach a person, and that is
 * the design rather than an omission.
 */

/** What the detail view puts on screen for a credential wait. */
export interface CredentialWaitReadout {
  /** True while the run is still waiting. Drives whether the copy is present or past tense. */
  readonly waiting: boolean
  /** The short line, for a heading. Sentence case. */
  readonly headline: string
  /** How long it has waited, or waited for — `m:ss`, the console's one clock. */
  readonly waitedFor: string
  /** The FR-029 sentence saying what is true of the pool. Rendered verbatim. */
  readonly summary: string
  /** The FR-029 sentence saying what would change it. Rendered verbatim, and separately. */
  readonly remedy: string
  /** The attached credential groups that were searched, in preference order. */
  readonly groups: readonly string[]
  /**
   * True when nothing will drain: the groups hold no credentials, or there are none attached.
   *
   * The one field the copy branches on, because it is the difference between "wait" and "somebody
   * has to fix this" — and a run left waiting out a configuration fault is exactly the failure
   * FR-029 was written against.
   */
  readonly configurationFault: boolean
}

/** One timeline entry, resolved into the wait it records. */
interface RecordedWait {
  readonly since: Date
  readonly detail: ReturnType<typeof credentialWaitDetail.parse>
}

/**
 * The most recent entry on the timeline that records a credential wait.
 *
 * Most recent rather than first: a run may in principle wait, start and wait again, and it is the
 * current wait a reader is asking about. The timeline arrives oldest-first, so this walks it
 * backwards and stops at the first match.
 *
 * @param timeline - The entries as `workflow.timeline` returned them.
 */
const latestWait = (timeline: readonly TimelineItem[]): RecordedWait | undefined => {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    // `noUncheckedIndexedAccess` is off in this app, so the element is typed as present; the loop
    // bounds are what make that true here rather than an assumption.
    const entry = timeline[index]
    const parsed = credentialWaitDetail.safeParse(entry.detail)

    if (parsed.success) {
      return { since: entry.createdAt, detail: parsed.data }
    }
  }

  return undefined
}

/**
 * When the wait ended — the first timeline entry written after it.
 *
 * Derived rather than reported. The two things that end a wait already write to the timeline: a
 * grant writes `admitted`, and the FR-028 expiry writes `failed`. A third "the wait ended" event
 * would be a message the panel's answer depended on, and it would have to be written at the exact
 * moment the run is being handed on to something else.
 *
 * @param timeline - The entries, oldest first.
 * @param since - When the wait began.
 */
const endedAt = (timeline: readonly TimelineItem[], since: Date): Date | undefined =>
  timeline.find((entry) => entry.createdAt.getTime() > since.getTime())?.createdAt

const HEADLINE = {
  waiting: 'Waiting for an agent credential',
  fault: 'Waiting for an agent credential that is not coming',
  past: 'Waited for an agent credential earlier in this run',
} as const

/**
 * Turn the run's timeline into what the panel says about its credential wait.
 *
 * @param options.state - The run's state now, which decides present or past tense.
 * @param options.timeline - The entries as `workflow.timeline` returned them, oldest first.
 * @param options.now - The page's clock, or `undefined` before the browser has one. While it is
 *   absent a live wait is measured to the entry that ended it, or reads as `0:00` — which errs
 *   toward saying nothing rather than toward inventing a duration on the server's clock.
 * @returns The readout, or `undefined` when this run has never waited for a credential.
 */
export const toCredentialWaitReadout = (options: {
  readonly state: WorkflowState
  readonly timeline: readonly TimelineItem[]
  readonly now: number | undefined
}): CredentialWaitReadout | undefined => {
  const recorded = latestWait(options.timeline)

  if (recorded === undefined) {
    return undefined
  }

  const waiting = options.state === 'awaiting_credential'
  const ended = endedAt(options.timeline, recorded.since)
  const until = waiting ? (options.now ?? ended?.getTime()) : ended?.getTime()
  const groups = recorded.detail.groups.map((group) => group.name)

  return {
    waiting,
    headline: waiting
      ? recorded.detail.configurationFault
        ? HEADLINE.fault
        : HEADLINE.waiting
      : HEADLINE.past,
    waitedFor: formatElapsed((until ?? recorded.since.getTime()) - recorded.since.getTime()),
    summary: recorded.detail.summary,
    remedy: recorded.detail.remedy,
    groups,
    configurationFault: recorded.detail.configurationFault,
  }
}
