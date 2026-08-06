'use client'

import {
  CLAUDE_MODELS,
  LOCKABLE_PROFILE_FIELDS,
  PURCHASE_MODES,
  WORKFLOW_TYPES,
} from '@bluetel-ai/sisyphus-api/client'
import { ChangeNotice, ElapsedReadout } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  FieldError,
  FieldLabel,
  StateChip,
} from '@sisyphus-admin/components/ui'
import type { LaunchOption } from '@sisyphus-admin/components/workflows/new'
import { LaunchSelect, PromptField } from '@sisyphus-admin/components/workflows/new'

import type { ProfileDraft, ProfileDraftErrors } from './profile-form-values'
import { withLockedField } from './profile-form-values'
import type { ProfileNotice } from './profile-outcome'

/**
 * The execution-profile editor — one form for creating and for editing (T082, FR-121, FR-123,
 * FR-125, FR-127).
 *
 * ## The submit button says what it will do
 *
 * `Create profile` and `Publish version 4` are different acts, and the button is the last place an
 * admin looks before performing one. A button saying `Save` on both would be the screen asserting
 * that editing mutates the configuration runs are using, which is the model FR-125 exists to
 * prevent anyone holding.
 *
 * ## Locking is stated as a consequence, not as a setting
 *
 * A locked field is refused for every run on this profile, forever, and the person it is refused to
 * is not in the room. So the lock controls carry the sentence that says what will happen on the
 * launch form, rather than presenting six checkboxes as a matter of preference.
 *
 * `LaunchSelect` and `PromptField` are imported from the launch screen's barrel because the
 * primitive set has neither a select nor a textarea; that is the promotion those two have now
 * earned, and a copy here would be the duplication the promotion exists to prevent.
 */

/** Read `on_demand` as words. The enum value is what the request carries either way. */
const PURCHASE_MODE_LABELS: Readonly<Record<string, string>> = {
  spot: 'Interruptible — cheaper, can be reclaimed mid-run',
  on_demand: 'Reserved — dearer, not reclaimed',
}

/** What each workflow type licenses a run on this profile to do without being asked again. */
const WORKFLOW_TYPE_LABELS: Readonly<Record<string, string>> = {
  delegated: 'Delegated — opens a draft pull request, moves no ticket',
  autonomous: 'Autonomous — runs unattended, so both caps are required',
  review: 'Review — reads and reports, changes nothing',
}

/** What each lockable field is called on screen. */
const LOCK_LABELS: Readonly<Record<string, string>> = {
  model: 'Model',
  instanceType: 'Instance size',
  purchaseMode: 'Capacity',
  turnCap: 'Turn cap',
  spendCap: 'Spend cap',
  workflowType: 'Workflow type',
}

const labelled = (
  values: readonly string[],
  labels: Readonly<Record<string, string>>,
): readonly LaunchOption[] => values.map((value) => ({ value, label: labels[value] ?? value }))

const MODEL_OPTIONS: readonly LaunchOption[] = CLAUDE_MODELS.map((model) => ({
  value: model,
  label: model,
}))

interface ProfileEditorProps {
  /** `undefined` when creating; the next version number when editing an existing profile. */
  nextVersion?: number
  draft: ProfileDraft
  errors: ProfileDraftErrors
  onChange: (patch: Partial<ProfileDraft>) => void
  onSubmit: () => void
  onCancel?: () => void
  /** Enabled workspaces, by the version this profile would pin. */
  workspaces: readonly LaunchOption[]
  /** Enabled setup bundles, by the version this profile would pin (FR-086). */
  bundles: readonly LaunchOption[]
  /** `Date.now()` when the change was submitted, or `undefined` when nothing is in flight. */
  startedAt?: number
  error?: FieldErrorContent
  notice?: ProfileNotice
}

export const ProfileEditor = ({
  nextVersion,
  draft,
  errors,
  onChange,
  onSubmit,
  onCancel,
  workspaces,
  bundles,
  startedAt,
  error,
  notice,
}: ProfileEditorProps) => {
  const pending = startedAt !== undefined
  const editing = nextVersion !== undefined

  return (
    <Card>
      <CardHeader>
        <span>{editing ? 'publish a new version' : 'new execution profile'}</span>
        <StateChip>{`locked ${String(draft.lockedFields.length)} of ${String(LOCKABLE_PROFILE_FIELDS.length)}`}</StateChip>
      </CardHeader>
      <CardBody className="gap-default flex flex-col">
        <p className="type-body text-graphite measure-prose">
          {editing
            ? `Editing does not change this profile. It publishes version ${String(nextVersion)} with the values below, and every workflow already running keeps the version it recorded at launch.`
            : 'A profile is the preset an engineer launches from, and the unit of access control. It arrives disabled and granted to nobody: enabling it runs a check that its setup bundle is enabled and every repository reachable.'}
        </p>

        <Field
          label="Name"
          value={draft.name}
          placeholder="Payments — delegated"
          disabled={pending}
          error={errors.name}
          onChange={(event) => {
            onChange({ name: event.target.value })
          }}
        />

        <Field
          label="Description"
          value={draft.description}
          placeholder="optional"
          disabled={pending}
          error={errors.description}
          onChange={(event) => {
            onChange({ description: event.target.value })
          }}
        />

        <LaunchSelect
          label="Workspace version"
          value={draft.workspaceVersionId}
          options={workspaces}
          placeholder={
            workspaces.length === 0 ? 'No enabled workspace is available' : 'Choose a workspace'
          }
          hint="the version is pinned, so a later workspace edit does not re-point this profile"
          disabled={pending || workspaces.length === 0}
          error={errors.workspaceVersionId}
          onChange={(workspaceVersionId) => {
            onChange({ workspaceVersionId })
          }}
        />

        <LaunchSelect
          label="Setup bundle version"
          value={draft.setupBundleVersionId}
          options={bundles}
          placeholder={
            bundles.length === 0 ? 'No enabled setup bundle is available' : 'Choose a bundle'
          }
          hint="the archive that turns a bare instance into one that can build these repositories"
          disabled={pending || bundles.length === 0}
          error={errors.setupBundleVersionId}
          onChange={(setupBundleVersionId) => {
            onChange({ setupBundleVersionId })
          }}
        />

        <LaunchSelect
          label="Default workflow type"
          value={draft.defaultWorkflowType}
          options={labelled([...WORKFLOW_TYPES], WORKFLOW_TYPE_LABELS)}
          placeholder="Choose how much a run may do unattended"
          disabled={pending}
          error={errors.defaultWorkflowType}
          onChange={(defaultWorkflowType) => {
            onChange({ defaultWorkflowType })
          }}
        />

        <LaunchSelect
          label="Model"
          value={draft.model}
          options={MODEL_OPTIONS}
          placeholder="Choose a model"
          disabled={pending}
          error={errors.model}
          onChange={(model) => {
            onChange({ model })
          }}
        />

        <Field
          label="Instance size"
          value={draft.instanceType}
          placeholder="m7i.large"
          disabled={pending}
          error={errors.instanceType}
          onChange={(event) => {
            onChange({ instanceType: event.target.value })
          }}
        />

        <LaunchSelect
          label="Capacity"
          value={draft.purchaseMode}
          options={labelled([...PURCHASE_MODES], PURCHASE_MODE_LABELS)}
          placeholder="Choose interruptible or reserved capacity"
          hint="an interrupted run is snapshotted and resumable, not lost"
          disabled={pending}
          error={errors.purchaseMode}
          onChange={(purchaseMode) => {
            onChange({ purchaseMode })
          }}
        />

        <Field
          label="Turn cap"
          value={draft.turnCap}
          inputMode="numeric"
          placeholder="blank for no cap"
          disabled={pending}
          error={errors.turnCap}
          onChange={(event) => {
            onChange({ turnCap: event.target.value })
          }}
        />

        <Field
          label="Spend cap"
          value={draft.spendCap}
          inputMode="decimal"
          placeholder="blank for no cap"
          disabled={pending}
          error={errors.spendCap}
          onChange={(event) => {
            onChange({ spendCap: event.target.value })
          }}
        />

        <PromptField
          label="Prompt preamble"
          hint="prepended to every prompt launched on this profile. sent as written"
          value={draft.promptPreamble}
          disabled={pending}
          error={errors.promptPreamble}
          onChange={(promptPreamble) => {
            onChange({ promptPreamble })
          }}
        />

        <div className="gap-tight flex flex-col">
          <FieldLabel>Locked fields</FieldLabel>
          <p className="type-body text-graphite measure-prose">
            A locked field is shown on the launch form as locked and refused if it is changed. Lock
            what a run must not vary — a spend cap somebody could raise for one run is not a cap.
          </p>
          <div className="gap-close flex flex-wrap">
            {LOCKABLE_PROFILE_FIELDS.map((field) => {
              const locked = draft.lockedFields.includes(field)

              return (
                <Button
                  key={field}
                  variant="secondary"
                  disabled={pending}
                  aria-pressed={locked}
                  onClick={() => {
                    onChange({ lockedFields: withLockedField(draft.lockedFields, field, !locked) })
                  }}
                >
                  {`${LOCK_LABELS[field] ?? field}: ${locked ? 'locked' : 'open'}`}
                </Button>
              )
            })}
          </div>
          {errors.lockedFields === undefined ? null : <FieldError {...errors.lockedFields} />}
        </div>

        {error === undefined ? null : <FieldError code={error.code} action={error.action} />}

        <div className="gap-close flex">
          {pending ? (
            <Button
              variant="primary"
              pending
              readout={<ElapsedReadout verb="Publishing" startedAt={startedAt} />}
            />
          ) : (
            <Button variant="primary" onClick={onSubmit}>
              {editing ? `Publish version ${String(nextVersion)}` : 'Create profile'}
            </Button>
          )}
          {onCancel === undefined ? null : (
            <Button variant="quiet" disabled={pending} onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>

        {notice === undefined ? null : (
          <ChangeNotice readout={notice.readout} detail={notice.detail} />
        )}
      </CardBody>
    </Card>
  )
}
