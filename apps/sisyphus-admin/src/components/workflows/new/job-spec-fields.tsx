'use client'

import { CLAUDE_MODELS, PURCHASE_MODES, WORKFLOW_TYPES } from '@bluetel-ai/sisyphus-api/client'
import { Field } from '@sisyphus-admin/components/ui'

import type { LaunchFieldErrors, LaunchFormValues } from './launch-form-values'
import type { LaunchOption } from './launch-select'
import { LaunchSelect } from './launch-select'

/**
 * The job spec — what runs, on what, at what cost (FR-016, FR-129, FR-187).
 *
 * These are the values an execution profile would otherwise have carried, which is exactly why
 * this path is admin-only: entering them here *is* using an unnamed profile, and a non-admin able
 * to do it would never need a granted one (FR-187, FR-180).
 *
 * Every closed vocabulary comes from the package's own tuples rather than from a list retyped
 * here. A model added to `CLAUDE_MODELS` appears in this picker with no edit; a model removed from
 * it disappears, instead of staying selectable until somebody notices (FR-009).
 */

/** Read `on_demand` as words. The enum value is what the request carries either way. */
const PURCHASE_MODE_LABELS: Readonly<Record<string, string>> = {
  spot: 'Interruptible — cheaper, can be reclaimed mid-run',
  on_demand: 'Reserved — dearer, not reclaimed',
}

/** What each workflow type licenses the agent to do without being asked again. */
const WORKFLOW_TYPE_LABELS: Readonly<Record<string, string>> = {
  delegated: 'Delegated — opens a draft pull request, moves no ticket',
  autonomous: 'Autonomous — runs unattended, so both caps are required',
  review: 'Review — reads and reports, changes nothing',
}

const labelled = (
  values: readonly string[],
  labels: Readonly<Record<string, string>>,
): readonly LaunchOption[] => values.map((value) => ({ value, label: labels[value] ?? value }))

const MODEL_OPTIONS: readonly LaunchOption[] = CLAUDE_MODELS.map((model) => ({
  value: model,
  label: model,
}))

interface JobSpecFieldsProps {
  values: LaunchFormValues
  errors: LaunchFieldErrors
  onChange: (patch: Partial<LaunchFormValues>) => void
  /** Enabled setup bundles, by the version a launch would pin (FR-016, FR-086). */
  bundles: readonly LaunchOption[]
  disabled?: boolean
}

export const JobSpecFields = ({
  values,
  errors,
  onChange,
  bundles,
  disabled = false,
}: JobSpecFieldsProps) => (
  <div className="gap-default flex flex-col">
    <LaunchSelect
      label="Workflow type"
      value={values.workflowType}
      options={labelled([...WORKFLOW_TYPES], WORKFLOW_TYPE_LABELS)}
      placeholder="Choose how much the agent may do unattended"
      disabled={disabled}
      error={errors.workflowType}
      onChange={(workflowType) => {
        onChange({ workflowType })
      }}
    />

    <LaunchSelect
      label="Model"
      value={values.model}
      options={MODEL_OPTIONS}
      placeholder="Choose a model"
      disabled={disabled}
      error={errors.model}
      onChange={(model) => {
        onChange({ model })
      }}
    />

    <Field
      label="Instance size"
      value={values.instanceType}
      placeholder="m7i.large"
      disabled={disabled}
      error={errors.instanceType}
      onChange={(event) => {
        onChange({ instanceType: event.target.value })
      }}
    />

    <LaunchSelect
      label="Capacity"
      value={values.purchaseMode}
      options={labelled([...PURCHASE_MODES], PURCHASE_MODE_LABELS)}
      placeholder="Choose interruptible or reserved capacity"
      hint="an interrupted run is snapshotted and resumable, not lost"
      disabled={disabled}
      error={errors.purchaseMode}
      onChange={(purchaseMode) => {
        onChange({ purchaseMode })
      }}
    />

    <Field
      label="Turn cap"
      value={values.turnCap}
      inputMode="numeric"
      placeholder="blank for no cap"
      disabled={disabled}
      error={errors.turnCap}
      onChange={(event) => {
        onChange({ turnCap: event.target.value })
      }}
    />

    <Field
      label="Spend cap"
      value={values.spendCap}
      inputMode="decimal"
      placeholder="blank for no cap"
      disabled={disabled}
      error={errors.spendCap}
      onChange={(event) => {
        onChange({ spendCap: event.target.value })
      }}
    />

    <LaunchSelect
      label="Setup bundle"
      value={values.setupBundleVersionId}
      options={bundles}
      placeholder={
        bundles.length === 0 ? 'No enabled setup bundle is available' : 'Choose a bundle'
      }
      hint="the archive that turns a bare instance into one that can build these repositories"
      disabled={disabled || bundles.length === 0}
      error={errors.setupBundleVersionId}
      onChange={(setupBundleVersionId) => {
        onChange({ setupBundleVersionId })
      }}
    />

    <Field
      label="Ticket reference"
      value={values.ticketReference}
      placeholder="optional"
      disabled={disabled}
      error={errors.ticketReference}
      onChange={(event) => {
        onChange({ ticketReference: event.target.value })
      }}
    />
  </div>
)
