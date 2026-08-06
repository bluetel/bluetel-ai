'use client'

import { describeTrpcError } from '@sisyphus-admin/components/admin'
import { Card, CardBody, CardHeader, FieldError, StateChip } from '@sisyphus-admin/components/ui'
import { WorkflowList, toWorkflowRowReadouts } from '@sisyphus-admin/components/workflows'
import type { LaunchOption } from '@sisyphus-admin/components/workflows/new'
import { api } from '@sisyphus-admin/trpc'

// `useNow` is not on `components/workflows`'s barrel, and this module may not add it there. One
// clock per page is the rule it exists to keep, so it is imported from the module rather than
// copied — a second interval would make two durations on the same screen disagree.
import { useNow } from '../use-now'

import { reassignmentCandidates, stoppedForMeInput, strandedOwners } from './needs-attention-input'
import { StrandedOwnerCard } from './stranded-owner-card'

/**
 * The needs-attention screen (T088, FR-134, FR-135, FR-176, FR-190).
 *
 * Wiring: two queries here, one more per stranded owner, and no state at all. Everything that can
 * be *wrong* — what each section actually asks for, who counts as stranded, what a reassignment
 * reports — lives in a module beside this one with its own test.
 *
 * ## Two sections, because they are two different obligations
 *
 * **What is waiting on me** is FR-135: runs I own that stopped at `needs_attention`. Anybody sees
 * their own; there is no owner parameter, because "what is waiting on somebody else" is a different
 * screen with different rules.
 *
 * **Runs with no accountable owner** is FR-176: a deactivated user's runs, flagged for
 * reassignment. It is rendered only for an admin, and not as a hidden section for everybody else:
 * `workflow.reassignOwner` and `admin.users.list` are both `adminProcedure`, so mounting them for a
 * non-admin would refuse *and record a `not_admin` denial* on the security trail for the ordinary
 * act of opening this page.
 *
 * ## What the reassignment queue is actually querying, and what is missing
 *
 * `workflows.needs_reassignment` is a column, but it is on neither `workflow.list`'s output nor its
 * filter set. So the queue is reconstructed from the two reads that exist: `admin.users.list`'s
 * `workflowsAwaitingReassignment` count identifies the deactivated owners, and one scoped
 * `workflow.list` per owner lists their non-terminal runs — which is the same set the flag marks,
 * for the reason set out in `./needs-attention-input.ts`. The honest fix is a `needsReassignment`
 * filter on `workflow.list`; until it exists, this page reconstructs rather than guesses.
 *
 * ## FR-190
 *
 * Nothing here decides what is visible. Both reads go through `scopedProcedure`, which composes the
 * base selector into the statement itself, so a run outside the caller's scope does not appear in a
 * list or in the counts above one. The visible count is shown next to the flagged count on each
 * owner's card precisely so the two being different reads as scoping rather than as a missing row.
 */

interface NeedsAttentionPanelProps {
  /** The signed-in user, resolved on the server. FR-135's scope is "mine", never a URL parameter. */
  readonly viewerUserId: string
  /** Whether the caller may clear the reassignment queue — that is, whether they are an admin. */
  readonly canReassign: boolean
}

export const NeedsAttentionPanel = ({ viewerUserId, canReassign }: NeedsAttentionPanelProps) => {
  const mine = api.workflow.list.useInfiniteQuery(stoppedForMeInput(viewerUserId), {
    getNextPageParam: (page) => page.nextCursor,
  })
  const users = api.admin.users.list.useQuery({ limit: 50 }, { enabled: canReassign })

  const now = useNow()
  const rows = (mine.data?.pages ?? [])
    .flatMap((page) => page.items)
    .map((item) => toWorkflowRowReadouts(item, now))

  const everyone = users.data?.items ?? []
  const owners = strandedOwners(everyone)
  const candidateNames = Object.fromEntries(
    everyone.map((user) => [user.id, user.displayName] as const),
  )

  return (
    <div className="gap-band flex flex-col">
      <div className="gap-section flex flex-col">
        <Card>
          <CardHeader>
            <span>waiting on you</span>
            <StateChip state="needs_attention">
              {mine.isPending ? 'reading' : `needs attention ${String(rows.length)}`}
            </StateChip>
          </CardHeader>
          <CardBody>
            <p className="type-body text-graphite measure-prose">
              Runs you own that have stopped and cannot go further without a person. Only yours, so
              this is the list you can act on rather than the fleet filtered down to it.
            </p>
          </CardBody>
        </Card>

        <WorkflowList
          rows={rows}
          loading={mine.isPending}
          loadingMore={mine.isFetchingNextPage}
          hasMore={mine.hasNextPage}
          error={mine.error === null ? undefined : describeTrpcError(mine.error)}
          onLoadMore={() => {
            void mine.fetchNextPage()
          }}
        />
      </div>

      {canReassign ? (
        <div className="gap-section flex flex-col">
          <Card>
            <CardHeader>
              <span>runs with no accountable owner</span>
              <StateChip>
                {users.isPending ? 'reading' : `owners ${String(owners.length)}`}
              </StateChip>
            </CardHeader>
            <CardBody className="gap-default flex flex-col">
              <p className="type-body text-graphite measure-prose">
                Deactivating a user flags every run of theirs still in flight, because every run has
                exactly one accountable human and theirs no longer has one. Reassigning clears the
                flag and records who moved it and when.
              </p>

              {users.error === null ? null : <FieldError {...describeTrpcError(users.error)} />}

              {users.isPending || owners.length > 0 ? null : (
                <p className="type-data-mono text-graphite">
                  every run in flight has an active owner
                </p>
              )}
            </CardBody>
          </Card>

          {owners.map((owner) => (
            <StrandedOwnerCard
              key={owner.userId}
              owner={owner}
              candidateNames={candidateNames}
              candidates={reassignmentCandidates(everyone, owner.userId).map(
                (user): LaunchOption => ({
                  value: user.id,
                  label: `${user.displayName} — ${user.email}`,
                }),
              )}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
