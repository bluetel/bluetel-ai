import { StateChip } from '@sisyphus-admin/components/ui'

interface ChangeNoticeProps {
  /** The state readout for the chip — `flagged 3`, `cascade 2`, `unchanged`. */
  readout: string
  /** What the change actually did, in a sentence. */
  detail: string
}

/**
 * What the panel says after a configuration change went through.
 *
 * A change that reports nothing is the failure mode both US12 and US13 name: a deactivation that
 * silently stranded a running workflow (FR-176), a revocation that silently removed a subscription
 * (FR-188). So every mutation on these screens renders one of these, including when the count is
 * zero — "nothing was left behind" is an answer to the same question, and an operator who only
 * ever sees a notice when something went wrong stops reading it.
 *
 * `role="status"` rather than `role="alert"`: this is the result of something the operator asked
 * for, so it should be announced politely rather than interrupting them. The chip is the idle
 * graphite one — the outcome of an admin action is not a workflow state, and `verdigris` here
 * would be a state colour used decoratively.
 */
export const ChangeNotice = ({ readout, detail }: ChangeNoticeProps) => (
  <div role="status" className="gap-tight flex flex-col">
    <StateChip>{readout}</StateChip>
    <p className="type-body text-graphite measure-prose">{detail}</p>
  </div>
)
