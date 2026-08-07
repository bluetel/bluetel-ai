'use client'

import { CLAUDE_MODELS, PURCHASE_MODES, WORKFLOW_TYPES } from '@bluetel-ai/sisyphus-api/client'
import { Field } from '@sisyphus-admin/components/ui'

import type { LaunchFormValues } from './launch-form-values'
import type { LaunchOption } from './launch-select'
import { LaunchSelect } from './launch-select'
import { LockedValue } from './locked-value'
import type { ProfileLaunchErrors } from './profile-launch-values'
import type { LaunchFieldLock } from './profile-locks'

/**
 * The six overridable values a profile prefills, each rendered as itself (T080, FR-122, FR-123).
 *
 * One list, two renderings per row: an editable control where the profile leaves the field open,
 * and a {@link LockedValue} readout where it does not. The decision is never taken here — it
 * arrives as {@link LaunchFieldLock}, computed in `profile-locks.ts` against the version's
 * `lockedFields`, so what a person sees and what the server would accept come from one rule.
 *
 * Every closed vocabulary comes from the package's own tuples rather than a list retyped here, for
 * the same reason `JobSpecFields` does it: a model added to `CLAUDE_MODELS` appears with no edit.
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

/** One clause of consequence per field, shown under the locked readout as well as the open one. */
const FIELD_HINTS: Readonly<Record<string, string>> = {
  purchaseMode: 'an interrupted run is snapshotted and resumable, not lost',
  turnCap: 'blank means no cap',
  spendCap: 'blank means no cap',
}

interface ProfileLaunchFieldsProps {
  locks: readonly LaunchFieldLock[]
  values: LaunchFormValues
  errors: ProfileLaunchErrors
  onChange: (patch: Partial<LaunchFormValues>) => void
  disabled?: boolean
}

/** The editable control for one open field. Split out so the row below reads as one decision. */
const OpenField = ({
  lock,
  values,
  errors,
  onChange,
  disabled,
}: ProfileLaunchFieldsProps & { lock: LaunchFieldLock }) => {
  switch (lock.field) {
    case 'workflowType':
      return (
        <LaunchSelect
          label={lock.label}
          value={values.workflowType}
          options={labelled([...WORKFLOW_TYPES], WORKFLOW_TYPE_LABELS)}
          placeholder="Choose how much the agent may do unattended"
          disabled={disabled}
          error={errors.workflowType}
          onChange={(workflowType) => {
            onChange({ workflowType })
          }}
        />
      )
    case 'model':
      return (
        <LaunchSelect
          label={lock.label}
          value={values.model}
          options={MODEL_OPTIONS}
          placeholder="Choose a model"
          disabled={disabled}
          error={errors.model}
          onChange={(model) => {
            onChange({ model })
          }}
        />
      )
    case 'purchaseMode':
      return (
        <LaunchSelect
          label={lock.label}
          value={values.purchaseMode}
          options={labelled([...PURCHASE_MODES], PURCHASE_MODE_LABELS)}
          placeholder="Choose interruptible or reserved capacity"
          hint={FIELD_HINTS.purchaseMode}
          disabled={disabled}
          error={errors.purchaseMode}
          onChange={(purchaseMode) => {
            onChange({ purchaseMode })
          }}
        />
      )
    case 'instanceType':
      return (
        <Field
          label={lock.label}
          value={values.instanceType}
          placeholder="m7i.large"
          disabled={disabled}
          error={errors.instanceType}
          onChange={(event) => {
            onChange({ instanceType: event.target.value })
          }}
        />
      )
    case 'turnCap':
      return (
        <Field
          label={lock.label}
          value={values.turnCap}
          inputMode="numeric"
          placeholder={FIELD_HINTS.turnCap}
          disabled={disabled}
          error={errors.turnCap}
          onChange={(event) => {
            onChange({ turnCap: event.target.value })
          }}
        />
      )
    case 'spendCap':
      return (
        <Field
          label={lock.label}
          value={values.spendCap}
          inputMode="decimal"
          placeholder={FIELD_HINTS.spendCap}
          disabled={disabled}
          error={errors.spendCap}
          onChange={(event) => {
            onChange({ spendCap: event.target.value })
          }}
        />
      )
  }
}

export const ProfileLaunchFields = (props: ProfileLaunchFieldsProps) => (
  <div className="gap-default flex flex-col">
    {props.locks.map((lock) =>
      lock.locked ? (
        <LockedValue
          key={lock.field}
          label={lock.label}
          value={lock.profileValue}
          blankReadout={
            lock.field === 'turnCap' || lock.field === 'spendCap' ? 'no cap' : 'not set'
          }
          hint={FIELD_HINTS[lock.field]}
          error={props.errors[lock.control]}
        />
      ) : (
        <OpenField key={lock.field} {...props} lock={lock} />
      ),
    )}
  </div>
)
