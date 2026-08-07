'use client'

import { ChangeNotice, ElapsedReadout } from '@sisyphus-admin/components/admin'
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

import { JobSpecFields } from './job-spec-fields'
import type { LaunchFieldErrors, LaunchFormValues } from './launch-form-values'
import type { LaunchNotice } from './launch-outcome'
import type { LaunchOption } from './launch-select'
import { PromptField } from './prompt-field'
import { WorkspaceSourceFields } from './workspace-source-fields'

/**
 * The ad hoc launch form (T064a, FR-016, FR-129, FR-187).
 *
 * Presentational and complete: every value, every refusal and every callback arrives as a prop, so
 * this component can be rendered and asserted without a tRPC provider. The queries and the
 * mutation live in `./ad-hoc-launch-panel.tsx`.
 *
 * ## Three cards, in the order the questions are asked
 *
 * What it checks out, what it runs on, and what to do — with the offer to keep the configuration
 * sitting under the last of them, where it reads as a consequence of what was entered rather than
 * as a seventh setting.
 *
 * ## One primary button
 *
 * DESIGN.md allows exactly one primary per view and this is it. In flight its label becomes a live
 * readout rather than a spinner: a spinner says something is happening, which the operator knew;
 * the readout says how long, which is what they wanted.
 */

interface AdHocLaunchFormProps {
  values: LaunchFormValues
  errors: LaunchFieldErrors
  onChange: (patch: Partial<LaunchFormValues>) => void
  onSubmit: () => void
  /** Enabled, published workspaces (FR-016). */
  workspaces: readonly LaunchOption[]
  /** Enabled setup bundles, by the version a launch would pin (FR-016, FR-086). */
  bundles: readonly LaunchOption[]
  /** `Date.now()` when the launch was submitted, or `undefined` when nothing is in flight. */
  startedAt?: number
  /** A refusal that belongs to the request rather than to one control. */
  error?: FieldErrorContent
  /** What the last completed launch did (FR-040). */
  notice?: LaunchNotice
}

export const AdHocLaunchForm = ({
  values,
  errors,
  onChange,
  onSubmit,
  workspaces,
  bundles,
  startedAt,
  error,
  notice,
}: AdHocLaunchFormProps) => {
  const pending = startedAt !== undefined

  return (
    <div className="gap-section flex flex-col">
      <Card>
        <CardHeader>
          <span>what it checks out</span>
          <StateChip>{`workspaces ${String(workspaces.length)}`}</StateChip>
        </CardHeader>
        <CardBody className="gap-default flex flex-col">
          <p className="type-body text-graphite measure-prose">
            A run pins the repository set it started with, so an edit afterwards never changes what
            a finished run says it checked out.
          </p>
          <WorkspaceSourceFields
            values={values}
            errors={errors}
            onChange={onChange}
            workspaces={workspaces}
            disabled={pending}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <span>what it runs on</span>
          <StateChip>{`bundles ${String(bundles.length)}`}</StateChip>
        </CardHeader>
        <CardBody className="gap-default flex flex-col">
          <p className="type-body text-graphite measure-prose">
            These are the values an execution profile would carry. Entering them directly is what
            makes this path admin-only — it is an unnamed profile, and it is not constrained by the
            profiles anybody holds.
          </p>
          <JobSpecFields
            values={values}
            errors={errors}
            onChange={onChange}
            bundles={bundles}
            disabled={pending}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <span>what to do</span>
          <StateChip>{pending ? 'launching' : 'ready'}</StateChip>
        </CardHeader>
        <CardBody className="gap-default flex flex-col">
          <PromptField
            value={values.prompt}
            error={errors.prompt}
            disabled={pending}
            onChange={(prompt) => {
              onChange({ prompt })
            }}
          />

          <Field
            label="Save this configuration as a profile"
            value={values.saveAsProfileName}
            placeholder="name it to save it, or leave blank"
            disabled={pending}
            error={errors.saveAsProfileName}
            onChange={(event) => {
              onChange({ saveAsProfileName: event.target.value })
            }}
          />
          <p className="type-body text-graphite measure-prose">
            Naming it saves it. The profile arrives disabled and granted to nobody — it cannot be
            enabled until validation confirms its repositories and setup bundle, which is the check
            that stands between a preset and a fleet of runs that cannot check out their code.
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
              <Button variant="primary" onClick={onSubmit}>
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
