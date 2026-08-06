'use client'

import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  FieldError,
  FieldLabel,
  FOCUS_RING,
  StateChip,
} from '@sisyphus-admin/components/ui'
import { cn } from '@sisyphus-admin/lib/cn'
import { useId } from 'react'

import { CredentialField } from './credential-field'
import type { IntegrationDraft, IntegrationDraftErrors } from './integration-form-values'
import { ScheduleField } from './schedule-field'

/** One thing a mapping may point at. */
export interface ProfileOption {
  readonly value: string
  readonly label: string
}

/** One person who could own what this board starts. */
export interface OwnerOption {
  readonly value: string
  readonly label: string
}

interface IntegrationEditorProps {
  draft: IntegrationDraft
  errors: IntegrationDraftErrors
  profiles: readonly ProfileOption[]
  owners: readonly OwnerOption[]
  /** True when an existing integration is being edited, which changes the credential notice. */
  editing?: boolean
  onChange: (patch: Partial<IntegrationDraft>) => void
  onSubmit: () => void
  onCancel: () => void
  /** Injectable so a rendering test states the clock. */
  now?: Date
  startedAt?: number
  error?: FieldErrorContent
}

/**
 * Creating and editing a board (T121, FR-096, FR-130, FR-133, FR-154, FR-158).
 *
 * ## The order the fields are in is the order the questions are asked in
 *
 * Where the board is, then what to look at, then who is accountable, then how work from it should
 * be approached, then when to look, then how much to start. That last pair is deliberate: the
 * ceilings sit immediately under the schedule, because "every five minutes" and "up to twenty runs
 * an hour" are one decision, and separating them is how an integration ends up with a schedule
 * nobody costed.
 *
 * ## Three fields the platform will refuse to enable without
 *
 * The default owner (FR-133), the prompt intro (FR-158) and at least one mapping (FR-130). They are
 * marked as such here rather than only refused on save, because meeting a requirement is cheaper
 * than being told about it — but the refusal still lives on the server, where it cannot be skipped.
 */
export const IntegrationEditor = ({
  draft,
  errors,
  profiles,
  owners,
  editing = false,
  onChange,
  onSubmit,
  onCancel,
  now,
  startedAt,
  error,
}: IntegrationEditorProps) => {
  const id = useId()
  const pending = startedAt !== undefined
  const selectClass = cn(
    'type-body w-full bg-paper text-ink',
    'rounded-sm p-close border border-hairline-hi',
    'hover:border-ink',
    FOCUS_RING,
  )

  return (
    <Card>
      <CardHeader>
        <span>{editing ? 'edit integration' : 'new integration'}</span>
        <StateChip>{`mappings ${String(draft.mappings.length)}`}</StateChip>
      </CardHeader>
      <CardBody className="gap-default flex flex-col">
        <p className="type-body text-graphite measure-prose">
          An integration carries no repository, branch, model, caps or bundle. Those come from the
          execution profile its mappings resolve to, so a board is only ever a description of where
          work arrives from and how often to look.
        </p>

        <Field
          label="Name"
          value={draft.name}
          error={errors.name}
          onChange={(event) => {
            onChange({ name: event.target.value })
          }}
        />

        <Field
          label="Board URL"
          value={draft.baseUrl}
          placeholder="https://example.atlassian.net"
          error={errors.baseUrl}
          onChange={(event) => {
            onChange({ baseUrl: event.target.value })
          }}
        />

        <CredentialField
          value={draft.credentialSecretArn}
          editing={editing}
          error={errors.credentialSecretArn}
          onChange={(value) => {
            onChange({ credentialSecretArn: value })
          }}
        />

        <Field
          label="Project prefix"
          value={draft.projectPrefix}
          error={errors.projectPrefix}
          onChange={(event) => {
            onChange({ projectPrefix: event.target.value })
          }}
        />

        <Field
          label="Label that marks a ticket for delivery"
          value={draft.label}
          error={errors.label}
          onChange={(event) => {
            onChange({ label: event.target.value })
          }}
        />

        <div className="gap-tight flex flex-col">
          <FieldLabel htmlFor={`${id}-filters`}>Extra filters</FieldLabel>
          <textarea
            id={`${id}-filters`}
            rows={3}
            spellCheck={false}
            value={draft.extraFilters}
            className={selectClass}
            placeholder={'{ "status": "Ready" }'}
            onChange={(event) => {
              onChange({ extraFilters: event.target.value })
            }}
          />
          <p className="type-body text-graphite measure-prose">
            A JSON object of extra board-side filters, or blank for none. A filter the connector
            cannot read fails the tick rather than being ignored — ignoring one would widen the
            query and start paid runs on tickets you believed were excluded.
          </p>
          {errors.extraFilters === undefined ? null : (
            <FieldError code={errors.extraFilters.code} action={errors.extraFilters.action} />
          )}
        </div>

        <div className="gap-tight flex flex-col">
          <FieldLabel htmlFor={`${id}-owner`}>Default owner — required to enable</FieldLabel>
          <select
            id={`${id}-owner`}
            value={draft.defaultOwnerUserId}
            className={selectClass}
            onChange={(event) => {
              onChange({ defaultOwnerUserId: event.target.value })
            }}
          >
            <option value="">Choose an owner</option>
            {owners.map((owner) => (
              <option key={owner.value} value={owner.value}>
                {owner.label}
              </option>
            ))}
          </select>
          <p className="type-body text-graphite measure-prose">
            Every run has exactly one accountable human. A ticket assignee the platform recognises
            takes ownership instead; this is who owns the rest.
          </p>
          {errors.defaultOwnerUserId === undefined ? null : (
            <FieldError
              code={errors.defaultOwnerUserId.code}
              action={errors.defaultOwnerUserId.action}
            />
          )}
        </div>

        <div className="gap-tight flex flex-col">
          <FieldLabel htmlFor={`${id}-intro`}>Prompt intro — required to enable</FieldLabel>
          <textarea
            id={`${id}-intro`}
            rows={4}
            value={draft.promptIntro}
            className={selectClass}
            onChange={(event) => {
              onChange({ promptIntro: event.target.value })
            }}
          />
          <p className="type-body text-graphite measure-prose">
            How work from this board should be approached. It sits between the execution
            profile&apos;s preamble and the ticket content in every prompt this integration
            generates.
          </p>
          {errors.promptIntro === undefined ? null : (
            <FieldError code={errors.promptIntro.code} action={errors.promptIntro.action} />
          )}
        </div>

        <ScheduleField
          expression={draft.cronExpression}
          timezone={draft.timezone}
          now={now}
          expressionError={errors.cronExpression}
          timezoneError={errors.timezone}
          onExpressionChange={(cronExpression) => {
            onChange({ cronExpression })
          }}
          onTimezoneChange={(timezone) => {
            onChange({ timezone })
          }}
        />

        <div className="gap-default grid grid-cols-1 sm:grid-cols-3">
          <Field
            label="Workflows per tick"
            value={draft.perTickCeiling}
            inputMode="numeric"
            error={errors.perTickCeiling}
            onChange={(event) => {
              onChange({ perTickCeiling: event.target.value })
            }}
          />
          <Field
            label="Workflows per period"
            value={draft.rollingPeriodCeiling}
            inputMode="numeric"
            error={errors.rollingPeriodCeiling}
            onChange={(event) => {
              onChange({ rollingPeriodCeiling: event.target.value })
            }}
          />
          <Field
            label="Period, in minutes"
            value={draft.rollingPeriodMinutes}
            inputMode="numeric"
            error={errors.rollingPeriodMinutes}
            onChange={(event) => {
              onChange({ rollingPeriodMinutes: event.target.value })
            }}
          />
        </div>

        <div className="gap-tight flex flex-col">
          <span className="type-label-mono text-graphite">
            mappings — first match by position wins
          </span>
          <p className="type-body text-graphite measure-prose">
            A ticket matching none of these is skipped with the reason recorded and a comment left
            on the ticket. It is never started under a guessed profile.
          </p>

          {draft.mappings.map((mapping, index) => (
            <div
              key={`${String(index)}-${mapping.executionProfileId}`}
              className="gap-tight border-hairline p-close flex flex-col rounded-sm border"
            >
              <Field
                label="Position"
                value={mapping.position}
                inputMode="numeric"
                onChange={(event) => {
                  onChange({
                    mappings: draft.mappings.map((entry, entryIndex) =>
                      entryIndex === index ? { ...entry, position: event.target.value } : entry,
                    ),
                  })
                }}
              />
              <div className="gap-tight flex flex-col">
                <FieldLabel htmlFor={`${id}-profile-${String(index)}`}>
                  Execution profile
                </FieldLabel>
                <select
                  id={`${id}-profile-${String(index)}`}
                  value={mapping.executionProfileId}
                  className={selectClass}
                  onChange={(event) => {
                    onChange({
                      mappings: draft.mappings.map((entry, entryIndex) =>
                        entryIndex === index
                          ? { ...entry, executionProfileId: event.target.value }
                          : entry,
                      ),
                    })
                  }}
                >
                  <option value="">Choose a profile</option>
                  {profiles.map((profile) => (
                    <option key={profile.value} value={profile.value}>
                      {profile.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="gap-tight flex flex-col">
                <FieldLabel htmlFor={`${id}-criteria-${String(index)}`}>Criteria</FieldLabel>
                <textarea
                  id={`${id}-criteria-${String(index)}`}
                  rows={3}
                  spellCheck={false}
                  value={mapping.criteria}
                  className={selectClass}
                  placeholder={'{ "issueType": "Bug" }'}
                  onChange={(event) => {
                    onChange({
                      mappings: draft.mappings.map((entry, entryIndex) =>
                        entryIndex === index ? { ...entry, criteria: event.target.value } : entry,
                      ),
                    })
                  }}
                />
              </div>
              <Button
                variant="secondary"
                onClick={() => {
                  onChange({
                    mappings: draft.mappings.filter((_, entryIndex) => entryIndex !== index),
                  })
                }}
              >
                Remove this mapping
              </Button>
            </div>
          ))}

          {errors.mappings === undefined ? null : (
            <FieldError code={errors.mappings.code} action={errors.mappings.action} />
          )}

          <div className="flex">
            <Button
              variant="secondary"
              onClick={() => {
                onChange({
                  mappings: [
                    ...draft.mappings,
                    {
                      position: String(draft.mappings.length),
                      criteria: '',
                      executionProfileId: '',
                      isDefault: draft.mappings.length === 0,
                    },
                  ],
                })
              }}
            >
              Add a mapping
            </Button>
          </div>
        </div>

        {error === undefined ? null : <FieldError code={error.code} action={error.action} />}

        <div className="gap-close flex">
          {pending ? (
            <Button pending readout="Saving">
              {editing ? 'Save changes' : 'Create the integration'}
            </Button>
          ) : (
            <Button onClick={onSubmit}>
              {editing ? 'Save changes' : 'Create the integration'}
            </Button>
          )}
          <Button variant="quiet" onClick={onCancel}>
            Cancel
          </Button>
        </div>

        <p className="type-body text-graphite measure-prose">
          A new integration is created disabled. Enabling it runs a check that it has an owner, a
          prompt intro and at least one mapping — and starting a board that has none of those is a
          scheduled spender nobody described.
        </p>
      </CardBody>
    </Card>
  )
}
