'use client'

import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import { Button, Card, CardBody, CardHeader, StateChip } from '@sisyphus-admin/components/ui'
import { api } from '@sisyphus-admin/trpc'
import { useState } from 'react'

import { AdHocLaunchForm } from './ad-hoc-launch-form'
import type { LaunchFieldErrors, LaunchFormValues } from './launch-form-values'
import { EMPTY_LAUNCH_FORM, toStartAdHocInput } from './launch-form-values'
import type { LaunchNotice } from './launch-outcome'
import {
  describeLaunch,
  describeLaunchError,
  describeProfileCatalogueError,
  describeProfileLaunch,
  describeProfileLaunchError,
  PROFILE_CATALOGUE_UNAVAILABLE,
} from './launch-outcome'
import type { LaunchOption } from './launch-select'
import { ProfileLaunchForm } from './profile-launch-form'
import type { ProfileLaunchErrors } from './profile-launch-values'
import { toStartWorkflowInput } from './profile-launch-values'
import { describeLaunchFieldLocks } from './profile-locks'
import {
  findLaunchProfile,
  prefillFromProfile,
  profileLaunchOptions,
  profileVersionReadouts,
} from './profile-prefill'

/**
 * The launch screen's data and state (T064a, T080, FR-016, FR-122, FR-129, FR-187).
 *
 * ## The seam T064a left, taken
 *
 * T064a documented that the profile-first path changes three things here and nothing below: the
 * values object is prefilled rather than blank, the mutation becomes `workflow.start`, and the
 * page's gate softens. All three are in this file. `AdHocLaunchForm`, `JobSpecFields`,
 * `WorkspaceSourceFields`, `PromptField`, `LaunchSelect` and `launch-form-values.ts` are untouched
 * — {@link LaunchFormValues} was defined as the whole launch configuration precisely so a profile
 * could fill it in, and it does.
 *
 * ## Two paths, one set of values
 *
 * The profile path is the default and, for a non-admin, the only one (FR-122, FR-187). An ad hoc
 * launch enters the same values by hand, which is what makes it an unnamed profile and what makes
 * it admin-only; the toggle to it is not rendered at all for anyone else, and the procedure behind
 * it refuses a second time and records the attempt.
 *
 * ## Where the profiles come from, and what is missing
 *
 * `admin.profiles.list` is the only mounted procedure that returns a profile with the version a
 * launch would pin, and it is an `adminProcedure`. There is no scoped "the profiles I may launch
 * on" read on the contract — `api-surface.md` lists none — so a non-admin currently has no source
 * for the picker, and mounting the admin one for them would refuse *and record a `not_admin`
 * denial* on the FR-180 trail for the ordinary act of opening the launch page. So the query is not
 * mounted for a non-admin, and the form says so through {@link describeProfileCatalogueError}
 * rather than showing an empty picker with no explanation.
 *
 * The shape of this component does not change when that procedure lands: only the query behind
 * `profiles` does.
 */

interface LaunchPanelProps {
  /**
   * Whether the caller may launch ad hoc — that is, whether they are an admin (FR-187).
   *
   * Resolved on the server by the page, never inferred in the browser. It gates the direct-entry
   * fields, and today it also gates the profile query, for the reason in the module comment.
   */
  readonly canLaunchAdHoc: boolean
  /** Where a started run is read afterwards. Passed in so this component builds no route. */
  readonly workflowPathPrefix?: string
}

const toWorkspaceOptions = (
  workspaces: readonly {
    readonly name: string
    readonly currentVersionId: string
    readonly entryCount: number
  }[],
): readonly LaunchOption[] =>
  workspaces.map((workspace) => ({
    value: workspace.currentVersionId,
    label: `${workspace.name} — ${String(workspace.entryCount)} repo${workspace.entryCount === 1 ? '' : 's'}`,
  }))

/** Which of the two ways of configuring a run the operator is using. */
type LaunchMode = 'profile' | 'ad-hoc'

export const LaunchPanel = ({
  canLaunchAdHoc,
  workflowPathPrefix = '/workflows',
}: LaunchPanelProps) => {
  const [mode, setMode] = useState<LaunchMode>('profile')
  const [values, setValues] = useState<LaunchFormValues>(EMPTY_LAUNCH_FORM)
  const [executionProfileId, setExecutionProfileId] = useState('')
  const [resumeFromSessionId, setResumeFromSessionId] = useState('')
  const [adHocErrors, setAdHocErrors] = useState<LaunchFieldErrors>({})
  const [profileErrors, setProfileErrors] = useState<ProfileLaunchErrors>({})
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  const [error, setError] = useState<FieldErrorContent | undefined>(undefined)
  const [notice, setNotice] = useState<LaunchNotice | undefined>(undefined)

  const profiles = api.admin.profiles.list.useQuery(
    { enabledOnly: true, limit: 50 },
    { enabled: canLaunchAdHoc },
  )
  const workspaces = api.workflow.adHocWorkspaces.useQuery(undefined, { enabled: canLaunchAdHoc })
  // Any authenticated user may read the enabled bundle list, because choosing one is part of
  // building a profile (FR-086). It is still only mounted on the ad hoc path, which is the only
  // path that asks anyone to choose one.
  const bundles = api.admin.bundles.list.useQuery(
    { enabledOnly: true, limit: 50 },
    { enabled: canLaunchAdHoc },
  )

  const launchAdHoc = api.workflow.startAdHoc.useMutation()
  const launchFromProfile = api.workflow.start.useMutation()

  const profileItems = profiles.data?.items ?? []
  const chosen = findLaunchProfile(profileItems, executionProfileId)
  const version = chosen?.currentVersion

  const bundleOptions: readonly LaunchOption[] = (bundles.data?.items ?? [])
    .filter((bundle) => bundle.latestVersion !== undefined)
    .map((bundle) => ({
      value: bundle.latestVersion?.id ?? '',
      label: `${bundle.name} — v${String(bundle.latestVersion?.version ?? 0)}`,
    }))

  const clearRefusals = () => {
    setAdHocErrors({})
    setProfileErrors({})
    setError(undefined)
    setNotice(undefined)
  }

  const selectProfile = (nextId: string) => {
    setExecutionProfileId(nextId)
    clearRefusals()

    const next = findLaunchProfile(profileItems, nextId)?.currentVersion
    // Every value the profile carries, in one act (FR-122). The prompt and the ticket reference
    // survive: they are the operator's own words about this run and no profile carries them.
    setValues((current) => (next === undefined ? current : prefillFromProfile(next, current)))
  }

  // Both submit paths take the clock as an argument rather than reading it here. `Date.now()` in a
  // component body is impure — two renders of the same props would produce different output — so
  // the reading happens in the event handler that starts the launch, exactly where it is caused.
  const submitProfile = (startedNow: number) => {
    const submission = toStartWorkflowInput(chosen, values, { resumeFromSessionId })
    setNotice(undefined)

    if (!submission.ok) {
      setError(undefined)
      setProfileErrors(submission.errors)
      return
    }

    setProfileErrors({})
    setError(undefined)
    setStartedAt(startedNow)

    launchFromProfile.mutate(submission.input, {
      onSuccess: (result) => {
        setStartedAt(undefined)
        setNotice(describeProfileLaunch(result, version?.version))
        // The prompt and the session reference are cleared and nothing else. A second run on the
        // same profile is the common next act, and re-selecting it would be busywork.
        setValues((current) => ({ ...current, prompt: '' }))
        setResumeFromSessionId('')
      },
      onError: (failure) => {
        setStartedAt(undefined)
        setError(describeProfileLaunchError(failure))
      },
    })
  }

  const submitAdHoc = (startedNow: number) => {
    const submission = toStartAdHocInput(values)
    setNotice(undefined)

    if (!submission.ok) {
      // Field-level refusals and the whole-request one are cleared together, so the form never
      // shows a stale error beside a control the operator has since corrected.
      setError(undefined)
      setAdHocErrors(submission.errors)
      return
    }

    setAdHocErrors({})
    setError(undefined)
    setStartedAt(startedNow)

    launchAdHoc.mutate(submission.input, {
      onSuccess: (result) => {
        setStartedAt(undefined)
        setNotice(describeLaunch(result))
        setValues((current) => ({ ...current, prompt: '', saveAsProfileName: '' }))
      },
      onError: (failure) => {
        setStartedAt(undefined)
        setError(describeLaunchError(failure))
      },
    })
  }

  // Until a scoped profile read exists, a caller who cannot reach the admin list has no source for
  // the picker at all — which is a fact about the platform, not an error the query returned.
  const catalogueError = !canLaunchAdHoc
    ? PROFILE_CATALOGUE_UNAVAILABLE
    : profiles.error === null
      ? undefined
      : describeProfileCatalogueError(profiles.error)

  const launchedId =
    mode === 'profile' ? launchFromProfile.data?.workflow.id : launchAdHoc.data?.workflow.id

  const settled =
    notice === undefined || launchedId === undefined
      ? notice
      : {
          readout: notice.readout,
          detail: `${notice.detail} It is at ${workflowPathPrefix}/${launchedId}.`,
        }

  return (
    <div className="gap-section flex flex-col">
      {canLaunchAdHoc ? (
        <Card>
          <CardHeader>
            <span>how this run is configured</span>
            <StateChip>{mode === 'profile' ? 'from a profile' : 'ad hoc'}</StateChip>
          </CardHeader>
          <CardBody className="gap-default flex flex-col">
            <p className="type-body text-graphite measure-prose">
              Launching from a profile is the path everybody has. Entering the configuration
              directly is the same thing without a name on it, which is why it is admin-only — it is
              not constrained by the profiles anybody holds.
            </p>
            <div className="gap-close flex">
              <Button
                variant="secondary"
                aria-pressed={mode === 'profile'}
                onClick={() => {
                  setMode('profile')
                  clearRefusals()
                }}
              >
                From a profile
              </Button>
              <Button
                variant="secondary"
                aria-pressed={mode === 'ad-hoc'}
                onClick={() => {
                  setMode('ad-hoc')
                  clearRefusals()
                }}
              >
                Enter it directly
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {mode === 'ad-hoc' && canLaunchAdHoc ? (
        <AdHocLaunchForm
          values={values}
          errors={adHocErrors}
          workspaces={toWorkspaceOptions(workspaces.data ?? [])}
          bundles={bundleOptions}
          startedAt={startedAt}
          error={error}
          notice={settled}
          onChange={(patch) => {
            setValues((current) => ({ ...current, ...patch }))
          }}
          onSubmit={() => {
            submitAdHoc(Date.now())
          }}
        />
      ) : (
        <ProfileLaunchForm
          profiles={profileLaunchOptions(profileItems)}
          executionProfileId={executionProfileId}
          onSelectProfile={selectProfile}
          readouts={version === undefined ? [] : profileVersionReadouts(version)}
          locks={version === undefined ? [] : describeLaunchFieldLocks(version)}
          values={values}
          errors={profileErrors}
          onChange={(patch) => {
            setValues((current) => ({ ...current, ...patch }))
          }}
          resumeFromSessionId={resumeFromSessionId}
          onResumeChange={setResumeFromSessionId}
          onSubmit={() => {
            submitProfile(Date.now())
          }}
          startedAt={startedAt}
          error={error}
          catalogueError={catalogueError}
          notice={settled}
        />
      )}
    </div>
  )
}
