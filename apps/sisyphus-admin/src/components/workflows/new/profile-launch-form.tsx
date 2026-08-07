'use client'

import { ChangeNotice, DataReadout, ElapsedReadout } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  FieldError,
  LoadingState,
  StateChip,
} from '@sisyphus-admin/components/ui'

import type { LaunchFormValues } from './launch-form-values'
import type { LaunchNotice } from './launch-outcome'
import type { LaunchOption } from './launch-select'
import { LaunchSelect } from './launch-select'
import { ProfileLaunchFields } from './profile-launch-fields'
import type { ProfileLaunchErrors } from './profile-launch-values'
import type { LaunchFieldLock } from './profile-locks'
import type { ProfileVersionReadout } from './profile-prefill'
import { PromptField } from './prompt-field'

/**
 * The profile-first launch form (T080, FR-016, FR-122, FR-123, FR-187).
 *
 * Presentational and complete: every value, every refusal and every callback arrives as a prop, so
 * this can be rendered and asserted without a tRPC provider. The queries and the mutation live in
 * `./launch-panel.tsx`.
 *
 * ## Three cards, and the middle one is the whole requirement
 *
 * *Which profile* · *what it will use* · *what to do*. The middle card is the visible form of
 * FR-122: selecting a profile prefills every value, so the card exists to **show** those values
 * rather than to collect them, and the prompt below it is the only thing anybody has to type.
 *
 * ## The session reference is not a launch value
 *
 * `resumeFromSessionId` restores a stored session into a **new** workflow, which FR-016 is explicit
 * is a different operation from continuing an existing run by its id. So it sits with the prompt —
 * the two things that are about this particular run — rather than among the configuration, and its
 * help text says which of the two operations it is. Continuing a run is done from that run's page.
 *
 * ## One primary button
 *
 * DESIGN.md allows exactly one primary per view. On this screen that is `Launch run`, and in flight
 * its label becomes a live readout rather than a spinner.
 */

interface ProfileLaunchFormProps {
  /** Enabled, published profiles the caller may launch on (FR-016). */
  profiles: readonly LaunchOption[]
  executionProfileId: string
  onSelectProfile: (executionProfileId: string) => void
  /** What the chosen version pins and cannot be overridden. Empty until a profile is chosen. */
  readouts: readonly ProfileVersionReadout[]
  /** Every overridable field, already marked open or locked (FR-123). */
  locks: readonly LaunchFieldLock[]
  values: LaunchFormValues
  errors: ProfileLaunchErrors
  onChange: (patch: Partial<LaunchFormValues>) => void
  resumeFromSessionId: string
  onResumeChange: (resumeFromSessionId: string) => void
  onSubmit: () => void
  /** `Date.now()` when the launch was submitted, or `undefined` when nothing is in flight. */
  startedAt?: number
  /** A refusal that belongs to the request rather than to one control. */
  error?: FieldErrorContent
  /** A refusal that belongs to reading the profile list itself, rather than to launching. */
  catalogueError?: FieldErrorContent
  /**
   * True while the profile list is being read.
   *
   * Without it this card had no loading case, and the consequence was worse than a missing state:
   * an in-flight read rendered `profiles 0` and offered the picker's *empty* placeholder — "No
   * execution profile is available to you" — which is a claim about the caller's access, made
   * before the platform had answered (FR-201). Reading and having none are now different screens.
   */
  loading?: boolean
  /** What the last completed launch did (FR-040). */
  notice?: LaunchNotice
}

export const ProfileLaunchForm = ({
  profiles,
  executionProfileId,
  onSelectProfile,
  readouts,
  locks,
  values,
  errors,
  onChange,
  resumeFromSessionId,
  onResumeChange,
  onSubmit,
  startedAt,
  error,
  catalogueError,
  loading = false,
  notice,
}: ProfileLaunchFormProps) => {
  const pending = startedAt !== undefined
  const chosen = readouts.length > 0

  return (
    <div className="gap-section flex flex-col">
      <Card>
        <CardHeader>
          <span>which profile</span>
          <StateChip>{loading ? 'reading' : `profiles ${String(profiles.length)}`}</StateChip>
        </CardHeader>
        <CardBody className="gap-default flex flex-col">
          <p className="type-body text-graphite measure-prose">
            An execution profile carries the workspace, the model, the instance size, the capacity
            preference, both caps and the setup bundle. Choosing one fills all of them in, so the
            prompt is the only thing left to supply.
          </p>
          {catalogueError === undefined ? null : <FieldError {...catalogueError} />}

          {loading ? <LoadingState>reading the profiles you may launch on</LoadingState> : null}

          {loading || catalogueError !== undefined || profiles.length > 0 ? null : (
            <EmptyState>no execution profile has been granted to you</EmptyState>
          )}

          <LaunchSelect
            label="Execution profile"
            value={executionProfileId}
            options={profiles}
            placeholder={
              loading
                ? 'Reading the profiles you may launch on'
                : profiles.length === 0
                  ? 'No execution profile is available to you'
                  : 'Choose a profile'
            }
            hint="only enabled profiles with a published version can start a run"
            disabled={pending || loading || profiles.length === 0}
            error={errors.executionProfileId}
            onChange={onSelectProfile}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <span>what it will use</span>
          <StateChip>{chosen ? 'prefilled' : 'awaiting profile'}</StateChip>
        </CardHeader>
        <CardBody className="gap-default flex flex-col">
          {chosen ? (
            <>
              <p className="type-body text-graphite measure-prose">
                These are the values this run will use. The run records the profile version it
                launched from, so an edit to the profile afterwards leaves this run on the version
                below. A field the profile locks is shown as locked rather than offered and then
                refused.
              </p>
              <div className="gap-default flex flex-wrap">
                {readouts.map((readout) => (
                  <DataReadout key={readout.label} label={readout.label} value={readout.value} />
                ))}
              </div>
              <ProfileLaunchFields
                locks={locks}
                values={values}
                errors={errors}
                onChange={onChange}
                disabled={pending}
              />
            </>
          ) : (
            <EmptyState>choose a profile to see what a run on it would use</EmptyState>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <span>what to do</span>
          <StateChip>{pending ? 'launching' : chosen ? 'ready' : 'awaiting profile'}</StateChip>
        </CardHeader>
        <CardBody className="gap-default flex flex-col">
          <PromptField
            value={values.prompt}
            error={errors.prompt}
            disabled={pending || !chosen}
            onChange={(prompt) => {
              onChange({ prompt })
            }}
          />

          <Field
            label="Ticket reference"
            value={values.ticketReference}
            placeholder="optional"
            disabled={pending || !chosen}
            error={errors.ticketReference}
            onChange={(event) => {
              onChange({ ticketReference: event.target.value })
            }}
          />

          <Field
            label="Restore a stored session"
            value={resumeFromSessionId}
            placeholder="optional session id"
            disabled={pending || !chosen}
            error={errors.resumeFromSessionId}
            onChange={(event) => {
              onResumeChange(event.target.value)
            }}
          />
          <p className="type-body text-graphite measure-prose">
            This starts a <em>new</em> run from a stored session, which is not the same act as
            carrying on with an existing one — continue a run from its own page. A session that has
            passed its retention limit is refused with the limit stated.
          </p>

          {error === undefined ? null : <FieldError code={error.code} action={error.action} />}

          <div className="flex">
            {pending ? (
              <Button
                variant="primary"
                pending
                readout={<ElapsedReadout verb="Launching" startedAt={startedAt} />}
              />
            ) : (
              <Button variant="primary" disabled={!chosen} onClick={onSubmit}>
                Launch run
              </Button>
            )}
          </div>

          {notice === undefined ? null : (
            <ChangeNotice readout={notice.readout} detail={notice.detail} />
          )}
        </CardBody>
      </Card>
    </div>
  )
}
