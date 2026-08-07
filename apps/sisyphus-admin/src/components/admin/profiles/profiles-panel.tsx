'use client'

import { describeTrpcError } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FieldError,
  StateChip,
} from '@sisyphus-admin/components/ui'
import type { LaunchOption } from '@sisyphus-admin/components/workflows/new'
import { api } from '@sisyphus-admin/trpc'
import { useState } from 'react'

import type { EnableFailureNotice } from './enable-refusal'
import { describeEnableRefusal } from './enable-refusal'
import { ProfileCard } from './profile-card'
import { ProfileEditor } from './profile-editor'
import type { ProfileDraft, ProfileDraftErrors } from './profile-form-values'
import {
  draftFromProfileVersion,
  EMPTY_PROFILE,
  toCreateProfileInput,
  toUpdateProfileInput,
} from './profile-form-values'
import { toProfileReadouts } from './profile-listing'
import type { ProfileNotice } from './profile-outcome'
import {
  describeProfileEnable,
  describeProfileError,
  describeProfilePublish,
  describeProfileReferences,
} from './profile-outcome'

/**
 * The execution-profile admin screen (T082, FR-121..FR-128).
 *
 * Wiring: three queries, four mutations, and the editor state. Everything that can be *wrong* — how
 * a version reads, how a draft becomes a request, how the FR-124 refusal is broken back into its
 * elements — lives in a module beside this one with its own test.
 *
 * ## `includeArchived` is on
 *
 * An archived profile is still what a finished run was launched from, so hiding it would make that
 * run's own record unreadable from here. It is shown, marked archived, and refused for editing by
 * the router rather than by a guess made in the browser.
 */

/** Which profile, if any, is being edited. `new` is the create form. */
type EditorTarget = { readonly kind: 'new' } | { readonly kind: 'edit'; readonly id: string }

export const ProfilesPanel = () => {
  const [target, setTarget] = useState<EditorTarget | undefined>(undefined)
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_PROFILE)
  const [draftErrors, setDraftErrors] = useState<ProfileDraftErrors>({})
  const [cloneNames, setCloneNames] = useState<Readonly<Record<string, string>>>({})
  const [busyId, setBusyId] = useState<string | undefined>(undefined)
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  const [error, setError] = useState<FieldErrorContent | undefined>(undefined)
  const [enableFailures, setEnableFailures] = useState<readonly EnableFailureNotice[]>([])
  const [notice, setNotice] = useState<{ key: string; notice: ProfileNotice } | undefined>(
    undefined,
  )
  // Which profile's reference sweep is being read. One at a time, and only when asked: FR-127 asks
  // for what references a profile to be visible, not for fifty correlated counts on page load.
  const [referencesFor, setReferencesFor] = useState<string | undefined>(undefined)

  const utils = api.useUtils()
  const profiles = api.admin.profiles.list.useQuery({ includeArchived: true, limit: 50 })
  const workspaces = api.admin.workspaces.list.useQuery({ enabledOnly: true, limit: 50 })
  const bundles = api.admin.bundles.list.useQuery({ enabledOnly: true, limit: 50 })
  const references = api.admin.profiles.references.useQuery(
    { executionProfileId: referencesFor ?? '' },
    { enabled: referencesFor !== undefined },
  )

  const create = api.admin.profiles.create.useMutation()
  const update = api.admin.profiles.update.useMutation()
  const clone = api.admin.profiles.clone.useMutation()
  const setEnabled = api.admin.profiles.setEnabled.useMutation()

  const items = (profiles.data?.items ?? []).map(toProfileReadouts)

  const workspaceOptions: readonly LaunchOption[] = (workspaces.data?.items ?? [])
    .filter((workspace) => workspace.currentVersion !== undefined)
    .map((workspace) => ({
      value: workspace.currentVersion?.id ?? '',
      label: `${workspace.name} — v${String(workspace.currentVersion?.version ?? 0)}, ${String(workspace.currentVersion?.entries.length ?? 0)} repo${workspace.currentVersion?.entries.length === 1 ? '' : 's'}`,
    }))

  const bundleOptions: readonly LaunchOption[] = (bundles.data?.items ?? [])
    .filter((bundle) => bundle.latestVersion !== undefined)
    .map((bundle) => ({
      value: bundle.latestVersion?.id ?? '',
      label: `${bundle.name} — v${String(bundle.latestVersion?.version ?? 0)}`,
    }))

  const settle = async (key: string, settled: ProfileNotice) => {
    setStartedAt(undefined)
    setBusyId(undefined)
    setError(undefined)
    setEnableFailures([])
    setNotice({ key, notice: settled })
    await utils.admin.profiles.list.invalidate()
  }

  const refuse = (failure: unknown) => {
    setStartedAt(undefined)
    setBusyId(undefined)
    setEnableFailures([])
    setError(describeProfileError(failure))
  }

  const submitEditor = () => {
    setNotice(undefined)

    if (target?.kind === 'edit') {
      const submission = toUpdateProfileInput(target.id, draft)
      if (!submission.ok) {
        setError(undefined)
        setDraftErrors(submission.errors)
        return
      }

      setDraftErrors({})
      setError(undefined)
      setStartedAt(Date.now())
      update.mutate(submission.input, {
        onSuccess: (result) => {
          setTarget(undefined)
          void settle('editor', describeProfilePublish(result, 'edited'))
        },
        onError: refuse,
      })
      return
    }

    const submission = toCreateProfileInput(draft)
    if (!submission.ok) {
      setError(undefined)
      setDraftErrors(submission.errors)
      return
    }

    setDraftErrors({})
    setError(undefined)
    setStartedAt(Date.now())
    create.mutate(submission.input, {
      onSuccess: (result) => {
        setTarget(undefined)
        setDraft(EMPTY_PROFILE)
        void settle('editor', describeProfilePublish(result, 'created'))
      },
      onError: refuse,
    })
  }

  return (
    <div className="gap-section flex flex-col">
      <Card>
        <CardHeader>
          <span>execution profiles</span>
          <StateChip>{profiles.isPending ? 'reading' : `loaded ${String(items.length)}`}</StateChip>
        </CardHeader>
        <CardBody className="gap-default flex flex-col">
          <p className="type-body text-graphite measure-prose">
            A profile is the preset an engineer launches from, and the unit of access control. It is
            versioned: editing publishes a new version, and a workflow records the version it
            launched from, so a run in flight is never changed by an edit. Enabling one runs a check
            that its setup bundle is enabled and every repository in its workspace reachable.
          </p>

          {profiles.error === null ? null : <FieldError {...describeTrpcError(profiles.error)} />}

          {profiles.isPending || items.length > 0 ? null : (
            <p className="type-data-mono text-graphite">no execution profiles have been created</p>
          )}

          {target === undefined ? (
            <div className="flex">
              <Button
                variant="secondary"
                onClick={() => {
                  setDraft(EMPTY_PROFILE)
                  setDraftErrors({})
                  setError(undefined)
                  setEnableFailures([])
                  setNotice(undefined)
                  setTarget({ kind: 'new' })
                }}
              >
                New execution profile
              </Button>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {target === undefined ? null : (
        <ProfileEditor
          nextVersion={
            target.kind === 'edit'
              ? ((profiles.data?.items ?? []).find((item) => item.id === target.id)?.versionCount ??
                  0) + 1
              : undefined
          }
          draft={draft}
          errors={draftErrors}
          workspaces={workspaceOptions}
          bundles={bundleOptions}
          startedAt={busyId === undefined ? startedAt : undefined}
          error={busyId === undefined ? error : undefined}
          notice={notice?.key === 'editor' ? notice.notice : undefined}
          onChange={(patch) => {
            setDraft((current) => ({ ...current, ...patch }))
          }}
          onSubmit={submitEditor}
          onCancel={() => {
            setTarget(undefined)
            setDraftErrors({})
            setError(undefined)
          }}
        />
      )}

      {items.map((profile) => (
        <ProfileCard
          key={profile.id}
          profile={profile}
          cloneName={cloneNames[profile.id] ?? ''}
          startedAt={busyId === profile.id ? startedAt : undefined}
          error={busyId === profile.id ? error : undefined}
          enableFailures={busyId === profile.id ? enableFailures : []}
          notice={notice?.key === profile.id ? notice.notice : undefined}
          references={
            referencesFor === profile.id && references.data !== undefined
              ? describeProfileReferences(references.data)
              : undefined
          }
          onShowReferences={() => {
            setReferencesFor(profile.id)
          }}
          onCloneNameChange={(name) => {
            setCloneNames((current) => ({ ...current, [profile.id]: name }))
          }}
          onEdit={() => {
            const source = (profiles.data?.items ?? []).find((item) => item.id === profile.id)
            if (source?.currentVersion === undefined) return

            setDraft(draftFromProfileVersion(source.currentVersion, source))
            setDraftErrors({})
            setError(undefined)
            setEnableFailures([])
            setNotice(undefined)
            setTarget({ kind: 'edit', id: profile.id })
          }}
          onSetEnabled={(enabled) => {
            setBusyId(profile.id)
            setStartedAt(Date.now())
            setEnableFailures([])
            setNotice(undefined)
            setEnabled.mutate(
              { executionProfileId: profile.id, enabled },
              {
                onSuccess: (result) => {
                  void settle(profile.id, describeProfileEnable(result))
                },
                onError: (failure) => {
                  // The FR-124 gate names every failing element, and the panel keeps that shape:
                  // one field error per element rather than one sentence for all of them.
                  const refusal = describeEnableRefusal(failure)
                  setStartedAt(undefined)
                  setError(refusal.error)
                  setEnableFailures(refusal.failures)
                },
              },
            )
          }}
          onClone={() => {
            setBusyId(profile.id)
            setStartedAt(Date.now())
            setEnableFailures([])
            setNotice(undefined)
            clone.mutate(
              { executionProfileId: profile.id, name: (cloneNames[profile.id] ?? '').trim() },
              {
                onSuccess: (result) => {
                  setCloneNames((current) => ({ ...current, [profile.id]: '' }))
                  void settle(profile.id, describeProfilePublish(result, 'cloned'))
                },
                onError: refuse,
              },
            )
          }}
        />
      ))}
    </div>
  )
}
