'use client'

import { describeTrpcError } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FieldError,
  LoadingState,
  StateChip,
} from '@sisyphus-admin/components/ui'
import { api } from '@sisyphus-admin/trpc'
import { useState } from 'react'

import { CreateGroupForm } from './create-group-form'
import type { DeletionConditionNotice } from './deletion-refusal'
import { describeDeletionRefusal } from './deletion-refusal'
import type { CredentialGroupRenameDraft } from './group-card'
import { CredentialGroupCard } from './group-card'
import { ABSENT, toCredentialGroupReadouts } from './group-listing'
import type { CredentialGroupNotice } from './group-outcome'
import {
  describeCredentialGroupCreated,
  describeCredentialGroupDeleted,
  describeCredentialGroupEnable,
  describeCredentialGroupError,
  describeCredentialGroupRenamed,
} from './group-outcome'

/**
 * The credential-group management screen (T026, FR-060, FR-066, FR-067).
 *
 * Wiring: one query, four mutations, and the per-card form state. Everything that can be *wrong* —
 * how a group's counts read, how FR-066's two conditions are named, what each change is reported as
 * — lives in a module beside this one with its own test.
 *
 * ## `includeArchived` is on
 *
 * A deleted group is still what a historical credential was filed under and still appears on the
 * audit trail, so hiding it would make those entries unreadable from here. It is listed, marked
 * `deleted`, and offers no controls at all — the router would refuse them, and a control that
 * exists only to be refused is a question the screen should have answered.
 */

/** The create form's fields, and what they are reset to once a group has been created. */
const EMPTY_DRAFT = { name: '', description: '' }

/**
 * The key a notice and an in-flight change are filed under.
 *
 * The create form's own changes are keyed `create` and every card's by its group id, so a refusal
 * lands on the control that caused it rather than at the top of a screen holding twenty groups.
 */
const CREATE_KEY = 'create'

export const CredentialGroupsPanel = () => {
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const [renames, setRenames] = useState<Readonly<Record<string, CredentialGroupRenameDraft>>>({})
  const [busyId, setBusyId] = useState<string | undefined>(undefined)
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  const [error, setError] = useState<FieldErrorContent | undefined>(undefined)
  const [deletionConditions, setDeletionConditions] = useState<readonly DeletionConditionNotice[]>(
    [],
  )
  const [notice, setNotice] = useState<{ key: string; notice: CredentialGroupNotice } | undefined>(
    undefined,
  )

  const utils = api.useUtils()
  const groups = api.admin.credentialGroups.list.useQuery({ includeArchived: true, limit: 50 })

  const create = api.admin.credentialGroups.create.useMutation()
  const rename = api.admin.credentialGroups.rename.useMutation()
  const setEnabled = api.admin.credentialGroups.setEnabled.useMutation()
  const remove = api.admin.credentialGroups.delete.useMutation()

  const items = (groups.data?.items ?? []).map(toCredentialGroupReadouts)

  const settle = async (key: string, settled: CredentialGroupNotice) => {
    setStartedAt(undefined)
    setBusyId(undefined)
    setError(undefined)
    setDeletionConditions([])
    setNotice({ key, notice: settled })
    await utils.admin.credentialGroups.list.invalidate()
  }

  const refuse = (failure: unknown) => {
    setStartedAt(undefined)
    setDeletionConditions([])
    setError(describeCredentialGroupError(failure))
  }

  const begin = (key: string | undefined) => {
    setBusyId(key)
    setStartedAt(Date.now())
    setError(undefined)
    setDeletionConditions([])
    setNotice(undefined)
  }

  return (
    <div className="gap-section flex flex-col">
      <Card>
        <CardHeader>
          <span>credential groups</span>
          <StateChip>{groups.isPending ? 'reading' : `loaded ${String(items.length)}`}</StateChip>
        </CardHeader>
        <CardBody className="gap-default flex flex-col">
          <p className="type-body text-graphite measure-prose">
            A credential group is the pool an execution profile draws its agent identity from. A
            group that holds a credential, or that a profile is attached to, cannot be deleted — it
            is disabled instead, which withholds every member from future selection without
            interrupting a run currently holding one.
          </p>

          {groups.error === null ? null : <FieldError {...describeTrpcError(groups.error)} />}

          {groups.isPending ? <LoadingState>reading the credential groups</LoadingState> : null}

          {groups.isPending || groups.error !== null || items.length > 0 ? null : (
            <EmptyState>no credential groups have been created</EmptyState>
          )}
        </CardBody>
      </Card>

      <CreateGroupForm
        name={draft.name}
        description={draft.description}
        startedAt={busyId === undefined ? startedAt : undefined}
        error={busyId === undefined ? error : undefined}
        notice={notice?.key === CREATE_KEY ? notice.notice : undefined}
        onChange={(patch) => {
          setDraft((current) => ({ ...current, ...patch }))
        }}
        onSubmit={() => {
          begin(undefined)
          create.mutate(
            {
              name: draft.name.trim(),
              ...(draft.description.trim() === '' ? {} : { description: draft.description.trim() }),
            },
            {
              onSuccess: (result) => {
                setDraft(EMPTY_DRAFT)
                void settle(CREATE_KEY, describeCredentialGroupCreated(result))
              },
              onError: refuse,
            },
          )
        }}
      />

      {items.map((group) => {
        // The rename fields open on what the group is called now, and switch to the
        // administrator's edit the moment they type. Held here rather than in the card so a
        // re-read of the list cannot overwrite an edit in progress.
        const values = renames[group.id] ?? {
          name: group.name,
          description: group.description === ABSENT ? '' : group.description,
        }

        return (
          <CredentialGroupCard
            key={group.id}
            group={group}
            rename={values}
            startedAt={busyId === group.id ? startedAt : undefined}
            error={busyId === group.id ? error : undefined}
            deletionConditions={busyId === group.id ? deletionConditions : []}
            notice={notice?.key === group.id ? notice.notice : undefined}
            onRenameChange={(patch) => {
              setRenames((current) => ({ ...current, [group.id]: { ...values, ...patch } }))
            }}
            onRename={() => {
              begin(group.id)
              rename.mutate(
                {
                  credentialGroupId: group.id,
                  name: values.name.trim(),
                  description: values.description.trim() === '' ? null : values.description.trim(),
                },
                {
                  onSuccess: (result) => {
                    void settle(group.id, describeCredentialGroupRenamed(result))
                  },
                  onError: refuse,
                },
              )
            }}
            onSetEnabled={(enabled) => {
              begin(group.id)
              setEnabled.mutate(
                { credentialGroupId: group.id, enabled },
                {
                  onSuccess: (result) => {
                    void settle(group.id, describeCredentialGroupEnable(result))
                  },
                  onError: refuse,
                },
              )
            }}
            onDelete={() => {
              begin(group.id)
              remove.mutate(
                { credentialGroupId: group.id },
                {
                  onSuccess: (result) => {
                    void settle(group.id, describeCredentialGroupDeleted(result))
                  },
                  onError: (failure) => {
                    // FR-066 names which condition applies, and the card keeps that shape: one field
                    // error per condition rather than one sentence for both.
                    const refusal = describeDeletionRefusal(failure)
                    setStartedAt(undefined)
                    setError(refusal.error)
                    setDeletionConditions(refusal.conditions)
                  },
                },
              )
            }}
          />
        )
      })}
    </div>
  )
}
