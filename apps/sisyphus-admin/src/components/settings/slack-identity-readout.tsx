import { DataReadout } from '@sisyphus-admin/components/admin'
import { Card, CardBody, CardHeader, StateChip } from '@sisyphus-admin/components/ui'

interface SlackIdentityReadoutProps {
  /**
   * The caller's resolved Slack member id, or `null` when the organisation identity resolved to
   * nobody. `null` is the whole reason this component exists — see below.
   */
  slackUserId: string | null
}

/**
 * Whether the caller can actually be notified (T159, FR-140).
 *
 * ## The unnotifiable state is the point
 *
 * Slack direct message is the only notification channel in scope (FR-136), and the recipient is
 * resolved from the user's organisation identity. A user with no resolvable Slack identity is
 * recorded as **unnotifiable**: their runs still run, nothing fails, and no message is ever
 * delivered. That combination is the dangerous one — everything looks fine from every other screen
 * in the panel, including the preferences below this card, which will happily record eight
 * decisions about messages that cannot arrive.
 *
 * So the absent case is not a quiet dash in a field. It is a card that says, in the prose face, that
 * notifications **will not be delivered** and what to do about it. A settings screen whose delivery
 * address is missing and which renders as if it had succeeded is precisely the failure FR-140 names,
 * and it is the one this component refuses to produce.
 *
 * The chip stays the idle graphite one in both cases: unnotifiable is a fact about an account, not a
 * machine state, and colouring it `rust` would report a failure that has not happened — nothing has
 * broken, and nothing will.
 *
 * The member id is shown when it resolved, because "notifications go somewhere" is a claim a person
 * should be able to check against the account they are actually reading.
 */
export const SlackIdentityReadout = ({ slackUserId }: SlackIdentityReadoutProps) => (
  <Card aria-label="Slack identity">
    <CardHeader>
      <span>where notifications go</span>
      <StateChip>{slackUserId === null ? 'unnotifiable' : 'resolved'}</StateChip>
    </CardHeader>

    <CardBody className="gap-default flex flex-col">
      {slackUserId === null ? (
        <>
          <p className="type-body text-ink measure-prose">
            No Slack identity resolved for your account, so notifications will not be delivered to
            you. Every preference below is still recorded, and none of the messages they describe
            will arrive.
          </p>
          <p className="type-body text-graphite measure-prose">
            Ask an admin to link your platform account to your Slack member id. Nothing about your
            runs is affected in the meantime — they start, run and finish exactly as they would
            otherwise; delivery is the only thing missing.
          </p>
        </>
      ) : (
        <>
          <p className="type-body text-graphite measure-prose">
            Notifications are delivered as a Slack direct message to the identity resolved from your
            organisation account. It is the only channel — there is no email fallback.
          </p>
          <DataReadout label="slack member" value={slackUserId} />
        </>
      )}
    </CardBody>
  </Card>
)
