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
import { api } from '@sisyphus-admin/trpc'
import { useState } from 'react'

import { WorkspaceCard } from './workspace-card'
import { WorkspaceEditor } from './workspace-editor'
import type { WorkspaceDraft, WorkspaceDraftErrors } from './workspace-entry-values'
import {
  draftFromVersion,
  EMPTY_WORKSPACE,
  toCreateWorkspaceInput,
  toUpdateWorkspaceInput,
} from './workspace-entry-values'
import { toWorkspaceReadouts } from './workspace-listing'
import type { WorkspaceNotice } from './workspace-outcome'
import {
  describeWorkspaceEnable,
  describeWorkspaceError,
  describeWorkspacePublish,
} from './workspace-outcome'

/**
 * The workspace admin screen (T082, FR-125, FR-127, FR-128).
 *
 * Wiring: one query, four mutations, and the editor state. Everything that can be *wrong* — how a
 * version reads, how an entry list becomes a request, what a published version says afterwards —
 * lives in a module beside this one with its own test.
 *
 * ## `includeArchived` is on
 *
 * An archived workspace is still the thing a finished run checked out, so hiding it would make a
 * run's own record unreadable from the admin surface. It is shown, marked archived, and refused for
 * editing by the router rather than by a guess made here.
 */

/** Which workspace, if any, is being edited. `new` is the create form. */
type EditorTarget = { readonly kind: 'new' } | { readonly kind: 'edit'; readonly id: string }

export const WorkspacesPanel = () => {
  const [target, setTarget] = useState<EditorTarget | undefined>(undefined)
  const [draft, setDraft] = useState<WorkspaceDraft>(EMPTY_WORKSPACE)
  const [draftErrors, setDraftErrors] = useState<WorkspaceDraftErrors>({})
  const [cloneNames, setCloneNames] = useState<Readonly<Record<string, string>>>({})
  const [busyId, setBusyId] = useState<string | undefined>(undefined)
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  const [error, setError] = useState<FieldErrorContent | undefined>(undefined)
  const [notice, setNotice] = useState<{ key: string; notice: WorkspaceNotice } | undefined>(
    undefined,
  )

  const utils = api.useUtils()
  const workspaces = api.admin.workspaces.list.useQuery({ includeArchived: true, limit: 50 })

  const create = api.admin.workspaces.create.useMutation()
  const update = api.admin.workspaces.update.useMutation()
  const clone = api.admin.workspaces.clone.useMutation()
  const setEnabled = api.admin.workspaces.setEnabled.useMutation()

  const items = (workspaces.data?.items ?? []).map(toWorkspaceReadouts)
  const editing =
    target?.kind === 'edit'
      ? (workspaces.data?.items ?? []).find((item) => item.id === target.id)
      : undefined

  const settle = async (key: string, settled: WorkspaceNotice) => {
    setStartedAt(undefined)
    setBusyId(undefined)
    setError(undefined)
    setNotice({ key, notice: settled })
    await utils.admin.workspaces.list.invalidate()
  }

  const refuse = (failure: unknown) => {
    setStartedAt(undefined)
    setBusyId(undefined)
    setError(describeWorkspaceError(failure))
  }

  const submitEditor = () => {
    setNotice(undefined)

    if (target?.kind === 'edit') {
      const submission = toUpdateWorkspaceInput(target.id, draft)
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
          void settle('editor', describeWorkspacePublish(result, 'edited'))
        },
        onError: refuse,
      })
      return
    }

    const submission = toCreateWorkspaceInput(draft)
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
        setDraft(EMPTY_WORKSPACE)
        void settle('editor', describeWorkspacePublish(result, 'created'))
      },
      onError: refuse,
    })
  }

  return (
    <div className="gap-section flex flex-col">
      <Card>
        <CardHeader>
          <span>workspaces</span>
          <StateChip>
            {workspaces.isPending ? 'reading' : `loaded ${String(items.length)}`}
          </StateChip>
        </CardHeader>
        <CardBody className="gap-default flex flex-col">
          <p className="type-body text-graphite measure-prose">
            A workspace is a repository set, and it is versioned. Editing one publishes a new
            version with its own entries; a workflow keeps resolving the version it pinned when it
            launched, so an edit mid-run never changes what an agent is working on.
          </p>

          {workspaces.error === null ? null : (
            <FieldError {...describeTrpcError(workspaces.error)} />
          )}

          {workspaces.isPending || items.length > 0 ? null : (
            <p className="type-data-mono text-graphite">no workspaces have been created</p>
          )}

          {target === undefined ? (
            <div className="flex">
              <Button
                variant="secondary"
                onClick={() => {
                  setDraft(EMPTY_WORKSPACE)
                  setDraftErrors({})
                  setError(undefined)
                  setNotice(undefined)
                  setTarget({ kind: 'new' })
                }}
              >
                New workspace
              </Button>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {target === undefined ? null : (
        <WorkspaceEditor
          nextVersion={editing?.currentVersion === undefined ? undefined : editing.versionCount + 1}
          draft={draft}
          errors={draftErrors}
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

      {items.map((workspace) => (
        <WorkspaceCard
          key={workspace.id}
          workspace={workspace}
          cloneName={cloneNames[workspace.id] ?? ''}
          startedAt={busyId === workspace.id ? startedAt : undefined}
          error={busyId === workspace.id ? error : undefined}
          notice={notice?.key === workspace.id ? notice.notice : undefined}
          onCloneNameChange={(name) => {
            setCloneNames((current) => ({ ...current, [workspace.id]: name }))
          }}
          onEdit={() => {
            const source = (workspaces.data?.items ?? []).find((item) => item.id === workspace.id)
            if (source === undefined) return

            setDraft(
              draftFromVersion({
                name: source.name,
                description: source.description,
                entries: toWorkspaceReadouts(source).entries,
              }),
            )
            setDraftErrors({})
            setError(undefined)
            setNotice(undefined)
            setTarget({ kind: 'edit', id: workspace.id })
          }}
          onSetEnabled={(enabled) => {
            setBusyId(workspace.id)
            setStartedAt(Date.now())
            setNotice(undefined)
            setEnabled.mutate(
              { workspaceId: workspace.id, enabled },
              {
                onSuccess: (result) => {
                  void settle(workspace.id, describeWorkspaceEnable(result))
                },
                onError: refuse,
              },
            )
          }}
          onClone={() => {
            setBusyId(workspace.id)
            setStartedAt(Date.now())
            setNotice(undefined)
            clone.mutate(
              { workspaceId: workspace.id, name: (cloneNames[workspace.id] ?? '').trim() },
              {
                onSuccess: (result) => {
                  setCloneNames((current) => ({ ...current, [workspace.id]: '' }))
                  void settle(workspace.id, describeWorkspacePublish(result, 'cloned'))
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
