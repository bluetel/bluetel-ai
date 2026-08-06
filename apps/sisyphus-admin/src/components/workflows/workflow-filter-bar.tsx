'use client'

import type { WorkflowState, WorkflowType } from '@bluetel-ai/sisyphus-api/client'
import { WORKFLOW_STATES, WORKFLOW_TYPES } from '@bluetel-ai/sisyphus-api/client'
import { Button, Card, CardBody, CardHeader, Field } from '@sisyphus-admin/components/ui'

import type { WorkflowFilters } from './workflow-filters'
import { hasActiveFilters, ID_FILTER_NAMES, invalidIdFilters } from './workflow-filters'

/**
 * The list's filter bar (FR-013).
 *
 * ## Two kinds of control, for two kinds of value
 *
 * State and type come from closed vocabularies, so they are toggles built from the `Button`
 * primitive — the whole set is visible, and choosing one is one click rather than opening a menu.
 * The panel has no select primitive and this component does not invent one: a hand-rolled
 * dropdown here would be exactly the duplicate of an existing primitive SC-015 audits for.
 *
 * The rest name a row by id, so they are text fields. That is not the end state — an execution
 * profile should be picked by name — but `admin.profiles`, `admin.workspaces` and
 * `admin.integrations` are later phases, and a picker cannot list what no procedure returns. The
 * fields say plainly that they take identifiers, which is honest, rather than a disabled select
 * that implies a list is coming back.
 *
 * ## Applied on submit, not on keystroke
 *
 * The bar edits a **draft**. Nothing is queried until the operator applies it. A list that
 * re-queried per keystroke would issue a scoped, filtered, index-walking read for every prefix of
 * a repository URL, which is precisely the load FR-013's responsiveness clause exists to bound.
 * The toggles go into the same draft, so a state and a search term are applied as one change
 * rather than as two pages of results.
 *
 * ## Refusing a mistyped id here rather than at the server
 *
 * An id field holding something that is not an identifier blocks the apply and marks the field.
 * Sending it instead would replace the list with a validation error, which reads as "the list is
 * broken" rather than as "that is not an id".
 */

/** Sentence case, because a toggle is a thing a person does — mono uppercase is for state readouts. */
const sentenceCase = (value: string): string =>
  `${value.slice(0, 1).toUpperCase()}${value.slice(1).replace(/_/g, ' ')}`

/** The label above each id field, and the identifier it takes. */
const ID_FIELD_LABELS = {
  initiatedByUserId: 'Initiating user id',
  originatingIntegrationId: 'Originating integration id',
  executionProfileId: 'Execution profile id',
  workspaceId: 'Workspace id',
  setupBundleId: 'Setup bundle id',
} as const satisfies Record<(typeof ID_FILTER_NAMES)[number], string>

interface WorkflowFilterBarProps {
  readonly filters: WorkflowFilters
  readonly onChange: (filters: WorkflowFilters) => void
  readonly onApply: () => void
  readonly onClear: () => void
  /** True while the filtered list is being read. */
  readonly pending?: boolean
}

export const WorkflowFilterBar = ({
  filters,
  onChange,
  onApply,
  onClear,
  pending = false,
}: WorkflowFilterBarProps) => {
  const invalid = invalidIdFilters(filters)

  const toggleState = (state: WorkflowState): void => {
    onChange({
      ...filters,
      states: filters.states.includes(state)
        ? filters.states.filter((value) => value !== state)
        : [...filters.states, state],
    })
  }

  const toggleType = (type: WorkflowType): void => {
    onChange({ ...filters, type: filters.type === type ? undefined : type })
  }

  return (
    <Card aria-label="Filters">
      <CardHeader>
        <span>filters</span>
      </CardHeader>

      <CardBody className="gap-default flex flex-col">
        <div className="gap-tight flex flex-col">
          <span className="type-label-mono text-graphite">status</span>
          <div className="gap-tight flex flex-wrap">
            {WORKFLOW_STATES.map((state) => (
              <Button
                key={state}
                variant={filters.states.includes(state) ? 'secondary' : 'quiet'}
                aria-pressed={filters.states.includes(state)}
                onClick={() => {
                  toggleState(state)
                }}
              >
                {sentenceCase(state)}
              </Button>
            ))}
          </div>
        </div>

        <div className="gap-tight flex flex-col">
          <span className="type-label-mono text-graphite">type</span>
          <div className="gap-tight flex flex-wrap">
            {WORKFLOW_TYPES.map((type) => (
              <Button
                key={type}
                variant={filters.type === type ? 'secondary' : 'quiet'}
                aria-pressed={filters.type === type}
                onClick={() => {
                  toggleType(type)
                }}
              >
                {sentenceCase(type)}
              </Button>
            ))}
          </div>
        </div>

        <Field
          label="Ticket reference or result branch"
          name="search"
          value={filters.search}
          autoComplete="off"
          onChange={(event) => {
            onChange({ ...filters, search: event.target.value })
          }}
        />

        <Field
          label="Repository URL"
          name="repositoryUrl"
          value={filters.repositoryUrl}
          autoComplete="off"
          onChange={(event) => {
            onChange({ ...filters, repositoryUrl: event.target.value })
          }}
        />

        {ID_FILTER_NAMES.map((name) => (
          <Field
            key={name}
            label={ID_FIELD_LABELS[name]}
            name={name}
            value={filters[name]}
            autoComplete="off"
            error={
              invalid.includes(name)
                ? {
                    code: 'E_NOT_AN_IDENTIFIER',
                    action:
                      'Paste the identifier from the record you are filtering by, or clear the field.',
                  }
                : undefined
            }
            onChange={(event) => {
              onChange({ ...filters, [name]: event.target.value })
            }}
          />
        ))}

        <div className="gap-close flex items-center">
          <Button variant="primary" disabled={invalid.length > 0 || pending} onClick={onApply}>
            Apply filters
          </Button>
          {hasActiveFilters(filters) ? (
            <Button variant="quiet" onClick={onClear}>
              Clear
            </Button>
          ) : null}
        </div>
      </CardBody>
    </Card>
  )
}
