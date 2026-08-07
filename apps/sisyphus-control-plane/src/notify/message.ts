import type { NotificationEvent } from '@bluetel-ai/sisyphus-api/client'

import type { NotificationSubject } from './notification-store'

/**
 * What the direct message says (FR-137).
 *
 * FR-137 names six things a notification must state — the workflow, its ticket, its workspace, the
 * state reached, the reason, and consumption to date — plus a direct link to the detail view. All
 * seven are assembled here, in one pure function, so "the message lost the ticket reference" is a
 * failing test rather than a thing somebody notices in Slack a fortnight later.
 *
 * ## The panel's base URL is a parameter, not an import
 *
 * FR-137's link has to point at the panel, and the control plane's environment has no variable
 * naming it — `env.ts` carries `SISYPHUS_MACHINE_SURFACE_URL`, which is the surface the *executor*
 * reports to and emphatically not somewhere a human should be sent. So the base URL is passed in.
 * Reading an absent variable here would have produced `undefined` in the middle of a URL in a
 * message to a person, which is worse than requiring the caller to have one.
 */

/** Where the panel lives, and how a workflow is addressed within it. */
export interface PanelLink {
  /** Origin, with or without a trailing slash. */
  readonly baseUrl: string
}

/** Everything a workflow message needs beyond the run itself. */
export interface WorkflowMessageInput {
  readonly subject: NotificationSubject
  readonly event: NotificationEvent
  readonly panel: PanelLink
  /**
   * How many transitions this message stands for (FR-139). Above one, the message says so — a
   * coalesced message that read like a single event would be a quieter lie than the burst it
   * replaced.
   */
  readonly coalescedCount?: number
}

/** The detail view for one run (FR-137). */
export const workflowDetailUrl = (panel: PanelLink, workflowId: string): string =>
  `${panel.baseUrl.replace(/\/+$/, '')}/workflows/${workflowId}`

/** Human wording for each event, in the order a reader meets them. */
const EVENT_HEADLINES: Readonly<Record<NotificationEvent, string>> = {
  workflow_succeeded: 'finished successfully',
  workflow_failed: 'failed',
  workflow_capped: 'stopped at its cap',
  workflow_cancelled: 'was cancelled',
  workflow_needs_attention: 'needs you',
  workflow_parked_resumable: 'is parked and can be resumed',
  review_iteration_failed: 'had a review iteration fail',
  integration_tick_summary: 'started new runs',
}

/** `4 of 40 turns`, or `4 turns` where the run is uncapped. */
const describeUsage = (used: number | string, cap: number | string | null, unit: string): string =>
  cap === null ? `${String(used)} ${unit}` : `${String(used)} of ${String(cap)} ${unit}`

/**
 * Compose the direct message for one workflow event (FR-137).
 *
 * Plain text rather than blocks: the message has to survive a notification preview, an email
 * digest and a screen reader, and none of those render block kit. Every line is one fact, so a
 * reader scanning on a phone finds the state and the link without expanding anything.
 *
 * @param input - See {@link WorkflowMessageInput}.
 */
export const composeWorkflowMessage = (input: WorkflowMessageInput): string => {
  const { subject, event, panel } = input
  const coalescedCount = input.coalescedCount ?? 1

  const headline = EVENT_HEADLINES[event]
  const ticket = subject.ticketReference ?? 'no ticket'
  const workspace = subject.workspaceName ?? 'an ad hoc workspace'

  const lines = [
    `Your run ${headline}.`,
    `Ticket: ${ticket}`,
    `Workspace: ${workspace}`,
    `State: ${subject.state}`,
    `Reason: ${subject.outcomeReason ?? 'none recorded'}`,
    `Used: ${describeUsage(subject.turnsUsed, subject.turnCap, 'turns')}, ${describeUsage(
      subject.spendUsed,
      subject.spendCap,
      'spent',
    )}`,
    workflowDetailUrl(panel, subject.workflowId),
  ]

  if (coalescedCount > 1) {
    // Stated rather than hidden: the reader is entitled to know this stands for several changes,
    // and without it a coalesced message looks like the platform dropped the others (FR-139).
    lines.splice(1, 0, `This covers ${String(coalescedCount)} changes in the last few minutes.`)
  }

  return lines.join('\n')
}

/** The one-message-per-tick summary (FR-139). */
export interface TickSummaryInput {
  readonly integrationName: string | null
  readonly workflowIds: readonly string[]
  readonly panel: PanelLink
}

/**
 * Compose the summary for an integration tick that started several runs (FR-139).
 *
 * It names no single workflow in its headline, because it is about none of them in particular —
 * which is also why the row it produces has a null `workflow_id`. The links are listed so the
 * message is still actionable, capped so a tick that started forty runs does not produce a wall.
 */
export const composeTickSummaryMessage = (input: TickSummaryInput): string => {
  const { integrationName, workflowIds, panel } = input
  const shown = workflowIds.slice(0, TICK_SUMMARY_LINK_LIMIT)
  const source = integrationName ?? 'An integration'

  const lines = [
    `${source} started ${String(workflowIds.length)} runs you own.`,
    ...shown.map((workflowId) => workflowDetailUrl(panel, workflowId)),
  ]

  if (workflowIds.length > shown.length) {
    lines.push(`…and ${String(workflowIds.length - shown.length)} more.`)
  }

  return lines.join('\n')
}

/** How many links a summary lists before it stops and counts the rest. */
export const TICK_SUMMARY_LINK_LIMIT = 5
