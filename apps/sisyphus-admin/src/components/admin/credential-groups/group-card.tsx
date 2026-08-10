'use client'

import { ChangeNotice, DataReadout, ElapsedReadout } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  FieldError,
  StateChip,
} from '@sisyphus-admin/components/ui'

import type { DeletionConditionNotice } from './deletion-refusal'
import { DELETION_ACTIONS, deletionConditionCode, DISABLE_ALTERNATIVE } from './deletion-refusal'
import type { CredentialGroupReadouts } from './group-listing'
import type { CredentialGroupNotice } from './group-outcome'

/**
 * One credential group, with FR-066 stated on it rather than discovered through it (T026, FR-060,
 * FR-066, FR-067).
 *
 * ## Delete is offered only where FR-066 permits it
 *
 * A group that holds a credential or is attached to a profile may not be deleted, and this card
 * does not render a Delete control for one. That is the same decision `ProfileCard` makes about
 * FR-128: a greyed-out button invites the question, and its absence is the design answering it.
 * What stands in its place is not silence — it is the **named conditions**, one per line, each with
 * the code and the next action that says where the fix happens, and the Disable control directly
 * underneath.
 *
 * ## The two conditions are never collapsed into one
 *
 * "This group is in use" would be true and useless. An attachment is undone on the named profile's
 * own screen; a member credential must be moved to another group or archived, and a run may be
 * holding it at this moment. Those are different jobs in different places, so they are two lines
 * with two codes — before the attempt, from the counts, and after a refusal, from the router's own
 * message. See `deletion-refusal.ts` for why both paths use one vocabulary.
 *
 * ## Disabling is the offered alternative, not a consolation
 *
 * FR-066's shape is "not deletable, disableable instead", so Disable is a primary control on every
 * blocked group, carrying the sentence that says what it does: every member withheld from future
 * selection, no run currently holding one interrupted.
 */

/** The rename form's two fields, held by the panel so this card holds no state. */
export interface CredentialGroupRenameDraft {
  readonly name: string
  readonly description: string
}

interface CredentialGroupCardProps {
  group: CredentialGroupReadouts
  rename: CredentialGroupRenameDraft
  onRenameChange: (patch: Partial<CredentialGroupRenameDraft>) => void
  onRename: () => void
  onSetEnabled: (enabled: boolean) => void
  onDelete: () => void
  /** `Date.now()` while this card's own change is in flight. */
  startedAt?: number
  error?: FieldErrorContent
  /** One entry per condition the router refused the delete on (FR-066). */
  deletionConditions?: readonly DeletionConditionNotice[]
  notice?: CredentialGroupNotice
}

export const CredentialGroupCard = ({
  group,
  rename,
  onRenameChange,
  onRename,
  onSetEnabled,
  onDelete,
  startedAt,
  error,
  deletionConditions = [],
  notice,
}: CredentialGroupCardProps) => {
  const pending = startedAt !== undefined
  // The router has the last word. Its counts and this card's can legitimately differ — the listing
  // excludes archived credentials and the reference sweep does not — so a refusal that has arrived
  // blocks the delete control even where the counts said nothing did.
  const refused = deletionConditions.length > 0
  const blocked = refused || group.blockers.length > 0

  return (
    <Card aria-label={`Credential group ${group.name}`}>
      <CardHeader>
        <span>{group.name}</span>
        <StateChip>{group.state}</StateChip>
      </CardHeader>

      <CardBody className="gap-default flex flex-col">
        <div className="gap-default flex flex-wrap">
          <DataReadout label="credentials" value={group.credentials} />
          <DataReadout label="attached profiles" value={group.attachedProfiles} />
          <DataReadout label="created" value={group.created} />
          <DataReadout label="description" value={group.description} />
        </div>

        {group.archived ? (
          <p className="type-body text-graphite measure-prose">
            This group has been deleted. The row is kept because its id appears on the audit trail
            and on the credentials that were filed under it, and nothing further can be done to it.
          </p>
        ) : (
          <>
            <Field
              label="Name"
              value={rename.name}
              placeholder="Payments"
              disabled={pending}
              onChange={(event) => {
                onRenameChange({ name: event.target.value })
              }}
            />

            <Field
              label="Description"
              value={rename.description}
              placeholder="optional"
              disabled={pending}
              onChange={(event) => {
                onRenameChange({ description: event.target.value })
              }}
            />

            {error === undefined ? null : <FieldError code={error.code} action={error.action} />}

            {deletionConditions.length === 0 ? null : (
              <ol
                className="gap-close flex flex-col"
                aria-label={`Why ${group.name} cannot be deleted`}
              >
                {deletionConditions.map((condition) => (
                  <li key={condition.detail} className="gap-hair flex flex-col">
                    <FieldError code={condition.error.code} action={condition.error.action} />
                    <p className="type-data-mono text-graphite">{condition.detail}</p>
                  </li>
                ))}
              </ol>
            )}

            {!refused && group.blockers.length > 0 ? (
              <ol
                className="gap-close flex flex-col"
                aria-label={`Why ${group.name} cannot be deleted`}
              >
                {group.blockers.map((blocker, index) => (
                  <li key={blocker} className="gap-hair flex flex-col">
                    <FieldError
                      code={deletionConditionCode(blocker)}
                      action={DELETION_ACTIONS[blocker]}
                    />
                    <p className="type-data-mono text-graphite">{group.blockerDetails[index]}</p>
                  </li>
                ))}
              </ol>
            ) : null}

            <p className="type-body text-graphite measure-prose">
              {blocked
                ? `${group.name} cannot be deleted while the conditions above hold. ${DISABLE_ALTERNATIVE}`
                : `Nothing refers to ${group.name}, so it may be deleted. ${DISABLE_ALTERNATIVE}`}
            </p>

            <div className="gap-close flex flex-wrap items-end">
              {pending ? (
                <Button
                  variant="secondary"
                  pending
                  readout={<ElapsedReadout verb="Working" startedAt={startedAt} />}
                />
              ) : (
                <>
                  <Button
                    variant="secondary"
                    disabled={rename.name.trim() === ''}
                    onClick={onRename}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => {
                      onSetEnabled(!group.enabled)
                    }}
                  >
                    {group.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  {blocked ? null : (
                    <Button variant="quiet" onClick={onDelete}>
                      Delete
                    </Button>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {notice === undefined ? null : (
          <ChangeNotice readout={notice.readout} detail={notice.detail} />
        )}
      </CardBody>
    </Card>
  )
}
