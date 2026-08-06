import { DataReadout, NotFoundCard } from '@sisyphus-admin/components/admin'
import { Card, CardBody, CardHeader, StateChip } from '@sisyphus-admin/components/ui'
import Link from 'next/link'

import type { ChainMember } from './chain-model'
import { chainNeighbours, orderChain, summariseChain, toChainReadouts } from './chain-model'
import type { LoadedChain } from './chain-walk'

/**
 * **The successor chain, traversable both ways (T102, FR-152, FR-190).**
 *
 * A chain is a narrative — "this run stopped at its cap, that one carried on" — so it is rendered
 * oldest first with each run's position stated, and the run whose page this is marked in place
 * rather than pulled out of the sequence.
 *
 * ## The two directions are links, not a layout
 *
 * FR-152 says traversable, which means the reader can *get there*. Every row is a link to that
 * run, and the two neighbours are called out separately as **continues** and **continued by**, so
 * moving one step either way is one click rather than a hunt through a list. A chain rendered as a
 * list with no links would satisfy "shown in both directions" and none of what the requirement is
 * for.
 *
 * ## The totals say what they are totals of
 *
 * Under FR-190 the chain is the part of it the caller may see, so the summed consumption is over
 * the visible members. The card says "across the chain you can see" rather than "across the chain",
 * because the difference matters to somebody comparing a total against an invoice, and a figure
 * that quietly means something narrower than its label is worse than no figure.
 *
 * ## An absent direction is stated, never left blank
 *
 * When the loader could not establish that nothing continues this run — which is the case whenever
 * the chain is assembled by walking backwards from `workflow.byId` — the card says so. Blank space
 * where "continued by" would go reads as "nothing continued it", which is a claim, and it would be
 * a claim nobody checked.
 */
interface WorkflowChainPanelProps {
  readonly requestedWorkflowId: string
  /** The assembled chain. `undefined` while it is being read. */
  readonly chain: LoadedChain | undefined
  readonly loading?: boolean
  /** True when the run itself is outside the caller's scope, or absent (FR-190). */
  readonly notFound?: boolean
  /** The page's clock, so every elapsed readout agrees. `undefined` before the browser has one. */
  readonly now?: number
}

const NeighbourLink = ({
  caption,
  member,
  absence,
}: {
  readonly caption: string
  readonly member: ChainMember | undefined
  readonly absence: string
}) => (
  <div className="gap-hair flex flex-col">
    <span className="type-label-mono text-graphite">{caption}</span>
    {member === undefined ? (
      <span className="type-data-mono text-graphite">{absence}</span>
    ) : (
      <Link
        href={`/workflows/${member.workflowId}/chain`}
        className="focus-ring type-data-mono text-signal"
      >
        {member.workflowId}
      </Link>
    )}
  </div>
)

export const WorkflowChainPanel = ({
  requestedWorkflowId,
  chain,
  loading = false,
  notFound = false,
  now,
}: WorkflowChainPanelProps) => {
  if (notFound) {
    return <NotFoundCard message="No such run." />
  }

  const members = chain === undefined ? [] : orderChain(chain.members)
  const readouts = toChainReadouts(members, requestedWorkflowId, now)
  const totals = summariseChain(members)
  const { previous, next } = chainNeighbours(members, requestedWorkflowId)
  const forwardKnown = chain?.completeness.reachedLatest === true

  return (
    <div className="gap-section flex flex-col">
      <Card aria-label="Chain consumption">
        <CardHeader>
          <span>chain consumption</span>
          <StateChip>{loading ? 'reading' : `runs ${String(totals.workflowCount)}`}</StateChip>
        </CardHeader>
        <CardBody className="gap-close flex flex-col">
          <div className="gap-default flex flex-wrap">
            <DataReadout label="runs in chain" value={String(totals.workflowCount)} />
            <DataReadout label="turns across chain" value={String(totals.turnsTotal)} />
            <DataReadout label="spend across chain" value={totals.spendTotal} />
          </div>
          <p className="type-body text-graphite measure-prose">
            Summed across the runs of this chain you are permitted to see. A run outside your access
            is not listed here and is not counted in these figures.
          </p>
        </CardBody>
      </Card>

      <Card aria-label="Chain navigation">
        <CardHeader>
          <span>chain navigation</span>
          <StateChip>{forwardKnown ? 'both directions' : 'backwards only'}</StateChip>
        </CardHeader>
        <CardBody className="gap-close flex flex-col">
          <div className="gap-default flex flex-wrap">
            <NeighbourLink
              caption="continues"
              member={previous}
              absence="nothing — this is the first run of the chain"
            />
            <NeighbourLink
              caption="continued by"
              member={next}
              absence={
                forwardKnown
                  ? 'nothing — this is the latest run of the chain'
                  : 'not established from this view'
              }
            />
          </div>
          {forwardKnown ? null : (
            <p className="type-body text-graphite measure-prose">
              This chain was assembled by following each run back to the one it continues, so
              anything that continues the newest run shown is not established here. Open the newest
              run to see the chain from its end.
            </p>
          )}
        </CardBody>
      </Card>

      <Card aria-label="Successor chain">
        <CardHeader>
          <span>successor chain</span>
          <StateChip>{loading ? 'reading' : `runs ${String(readouts.length)}`}</StateChip>
        </CardHeader>
        <CardBody className="gap-close flex flex-col">
          {loading || readouts.length > 0 ? null : (
            <p className="type-data-mono text-graphite">no runs in this chain</p>
          )}

          <ol className="gap-close flex flex-col">
            {readouts.map((member) => (
              <li key={member.workflowId} className="gap-close flex flex-col">
                <div className="gap-default flex flex-wrap">
                  <DataReadout label="position" value={String(member.position)} />
                  <div className="gap-hair flex flex-col">
                    <span className="type-label-mono text-graphite">run</span>
                    {member.isRequested ? (
                      <span className="type-data-mono text-ink">{member.runId} (this run)</span>
                    ) : (
                      <Link
                        href={`/workflows/${member.workflowId}/chain`}
                        className="focus-ring type-data-mono text-signal"
                      >
                        {member.runId}
                      </Link>
                    )}
                  </div>
                  <DataReadout label="state" value={member.stateReadout} />
                  <DataReadout label="model" value={member.model} />
                  <DataReadout label="turns" value={member.turns} />
                  <DataReadout label="spend" value={member.spend} />
                  <DataReadout label="started" value={member.startedAt} />
                </div>
                <span className="type-data-mono text-graphite">{member.relation}</span>
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>
    </div>
  )
}
