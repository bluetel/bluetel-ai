'use client'

import { Button, Card, CardBody, CardHeader, Field } from '@sisyphus-admin/components/ui'
import { LaunchSelect } from '@sisyphus-admin/components/workflows/new'

import type { ConfigurationScope } from './configuration-scope'
import {
  ENTITY_TYPE_OPTIONS,
  EMPTY_CONFIGURATION_SCOPE,
  hasConfigurationNarrowing,
  hasInvalidActor,
  hasInvalidConfigurationScope,
  hasInvalidEntityId,
} from './configuration-scope'

/**
 * The configuration trail's narrowing controls (FR-178, FR-031).
 *
 * ## Why the picker is `LaunchSelect` and not a new one
 *
 * The primitive set has no `Select`, and `components/workflows/new` already owns the one this app
 * uses — built from `fieldControlVariants`, the same `cva` the text control is built from, so a
 * picker and the field beside it cannot come apart. `components/admin/profiles` already reaches for
 * it across the same barrel boundary. A second select styled here would be the drift FR-033
 * forbids, and it would be a second opinion about what a disabled or invalid control looks like.
 *
 * ## Both id fields refuse rather than send
 *
 * An entity id or an actor id that is not an identifier marks its own field and blocks the read —
 * it is never forwarded. Sending it would replace the history with a validation error, which reads
 * as "the audit is broken" rather than as "that is not an id". The same rule the subject field
 * above it follows.
 *
 * Presentational apart from the two callbacks: it holds no state and issues no query, so every
 * state it can be in is reachable from props alone.
 */
interface ConfigurationFiltersProps {
  /** The draft the operator is editing, which is not yet what is being read. */
  readonly draft: ConfigurationScope
  readonly onChange: (next: ConfigurationScope) => void
  readonly onApply: (next: ConfigurationScope) => void
}

export const ConfigurationFilters = ({ draft, onChange, onApply }: ConfigurationFiltersProps) => (
  <Card aria-label="Configuration filters">
    <CardHeader>
      <span>configuration changes</span>
    </CardHeader>

    <CardBody className="gap-default flex flex-col">
      <p className="type-body text-graphite measure-prose">
        Leave these empty to read every recorded configuration change, newest first. Narrow by the
        kind of thing that was changed, by the identifier of one particular thing, or by the admin
        who made the change.
      </p>

      <LaunchSelect
        label="Kind of thing"
        value={draft.entityType}
        options={ENTITY_TYPE_OPTIONS}
        placeholder="anything"
        onChange={(entityType) => {
          onChange({ ...draft, entityType })
        }}
      />

      <Field
        label="Identifier"
        name="entityId"
        value={draft.entityId}
        autoComplete="off"
        error={
          hasInvalidEntityId(draft)
            ? {
                code: 'E_NOT_AN_IDENTIFIER',
                action: 'Paste the identifier from the record, or clear the field.',
              }
            : undefined
        }
        onChange={(event) => {
          onChange({ ...draft, entityId: event.target.value })
        }}
      />

      <Field
        label="Changed by"
        name="actorUserId"
        value={draft.actorUserId}
        autoComplete="off"
        error={
          hasInvalidActor(draft)
            ? {
                code: 'E_NOT_AN_IDENTIFIER',
                action: 'Paste the identifier from the user record, or clear the field.',
              }
            : undefined
        }
        onChange={(event) => {
          onChange({ ...draft, actorUserId: event.target.value })
        }}
      />

      <div className="gap-close flex items-center">
        <Button
          variant="primary"
          disabled={hasInvalidConfigurationScope(draft)}
          onClick={() => {
            onApply(draft)
          }}
        >
          Read changes
        </Button>
        {hasConfigurationNarrowing(draft) ? (
          <Button
            variant="quiet"
            onClick={() => {
              onApply(EMPTY_CONFIGURATION_SCOPE)
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>
    </CardBody>
  </Card>
)
