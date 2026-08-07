'use client'

import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FieldError,
  LoadingState,
  StateChip,
} from '@sisyphus-admin/components/ui'
import { useCallback, useEffect, useState } from 'react'

import { IntegrationCard } from './integration-card'
import { IntegrationEditor } from './integration-editor'
import type { OwnerOption, ProfileOption } from './integration-editor'
import type { IntegrationDraft, IntegrationDraftErrors } from './integration-form-values'
import {
  draftFromIntegration,
  EMPTY_INTEGRATION,
  toCreateIntegrationValues,
  toUpdateIntegrationValues,
} from './integration-form-values'
import { toIntegrationReadouts } from './integration-listing'
import type {
  IntegrationsClient,
  IntegrationView,
  PromptPreviewView,
  ValidationView,
} from './integrations-client'
import { PromptPreview } from './prompt-preview'
import type { RunHistoryRow } from './run-history'
import { looksSilentlyStalled, toRunHistory } from './run-history'

interface IntegrationsPanelProps {
  /** How the screen reaches the server. See `integrations-client.ts` for why this is injected. */
  client: IntegrationsClient
  profiles: readonly ProfileOption[]
  owners: readonly OwnerOption[]
  /** Injectable so a rendering test states the clock rather than racing it. */
  now?: Date
}

/** Which integration, if any, is being edited. */
type EditorTarget = { readonly kind: 'new' } | { readonly kind: 'edit'; readonly id: string }

/** One card's loaded tick history, and what it says about the board (FR-105). */
interface RunHistorySlice {
  readonly rows: readonly RunHistoryRow[]
  readonly stalled: boolean
}

const describeFailure = (failure: unknown): FieldErrorContent => ({
  code: 'E_INTEGRATION_ACTION_FAILED',
  action: failure instanceof Error ? failure.message : 'The action could not be completed.',
})

/**
 * The integration admin screen (T121, FR-096..FR-098, FR-105..FR-107, FR-130, FR-154, FR-155,
 * FR-160, FR-186).
 *
 * Wiring only. Everything that can be *wrong* lives in a module beside this one with its own test:
 * how a schedule reads and when it next fires (`cron-schedule`, `schedule-presets`), how a draft
 * becomes a request (`integration-form-values`), how a row reads (`integration-listing`), how the
 * tick history reads and when it signals a silent stall (`run-history`), and what each control
 * renders (`integration-card`, `integration-editor`, `credential-field`, `schedule-field`,
 * `prompt-preview`).
 *
 * ## Why it takes a client rather than calling tRPC
 *
 * `admin.integrations` is mounted, and `api-integrations-client.ts` is the adapter over it that
 * `integrations-screen.tsx` supplies. The port is kept because it is what lets this screen and its
 * parts be rendered and asserted on without a provider, a query client or a network.
 *
 * ## The credential never round-trips
 *
 * Editing loads a draft through `draftFromIntegration`, which leaves the credential blank because
 * nothing returns it. This component holds no other copy, and clears the draft on cancel — so a
 * value typed into the credential field exists in exactly one place and for exactly as long as the
 * form is open.
 */
export const IntegrationsPanel = ({ client, profiles, owners, now }: IntegrationsPanelProps) => {
  const [integrations, setIntegrations] = useState<readonly IntegrationView[]>([])
  const [listError, setListError] = useState<FieldErrorContent | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)

  const [target, setTarget] = useState<EditorTarget | undefined>(undefined)
  const [draft, setDraft] = useState<IntegrationDraft>(EMPTY_INTEGRATION)
  const [draftErrors, setDraftErrors] = useState<IntegrationDraftErrors>({})
  const [error, setError] = useState<FieldErrorContent | undefined>(undefined)
  const [busyId, setBusyId] = useState<string | undefined>(undefined)
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)

  const [validations, setValidations] = useState<Readonly<Record<string, ValidationView>>>({})
  const [previewFor, setPreviewFor] = useState<string>('')
  const [preview, setPreview] = useState<PromptPreviewView | undefined>(undefined)

  // Which integration is being deleted, and which has its history open. One at a time each: a
  // confirmation showing on two cards is a confirmation an admin can answer for the wrong one.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | undefined>(undefined)
  // A `Map` rather than a record: indexing a record types as present, which would make the "this
  // card has not opened its history" case invisible to the compiler at every use site.
  const [histories, setHistories] = useState<ReadonlyMap<string, RunHistorySlice>>(new Map())

  const refresh = useCallback(async () => {
    try {
      setIntegrations(await client.list())
      setListError(undefined)
    } catch (failure) {
      setListError(describeFailure(failure))
    } finally {
      setLoaded(true)
    }
  }, [client])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const settle = async () => {
    setStartedAt(undefined)
    setBusyId(undefined)
    setError(undefined)
    setConfirmingDeleteId(undefined)
    await refresh()
  }

  const refuse = (failure: unknown) => {
    setStartedAt(undefined)
    setBusyId(undefined)
    setError(describeFailure(failure))
  }

  const submitEditor = () => {
    if (target === undefined) {
      return
    }

    const submission =
      target.kind === 'edit'
        ? toUpdateIntegrationValues(target.id, draft, now)
        : toCreateIntegrationValues(draft, now)

    if (!submission.ok) {
      setError(undefined)
      setDraftErrors(submission.errors)
      return
    }

    setDraftErrors({})
    setError(undefined)
    setStartedAt(Date.now())

    const action =
      target.kind === 'edit'
        ? client.update({ ...submission.input, integrationId: target.id })
        : client.create({ ...submission.input, type: 'jira' })

    action.then(
      () => {
        setTarget(undefined)
        // Cleared rather than kept: the credential the admin typed lives no longer than the form.
        setDraft(EMPTY_INTEGRATION)
        void settle()
      },
      (failure: unknown) => {
        refuse(failure)
      },
    )
  }

  const act = (integrationId: string, action: Promise<void>) => {
    setBusyId(integrationId)
    setStartedAt(Date.now())
    action.then(
      () => {
        void settle()
      },
      (failure: unknown) => {
        refuse(failure)
      },
    )
  }

  return (
    <div className="gap-section flex flex-col">
      <Card>
        <CardHeader>
          <span>integrations</span>
          <StateChip>{loaded ? `loaded ${String(integrations.length)}` : 'reading'}</StateChip>
        </CardHeader>
        <CardBody className="gap-default flex flex-col">
          <p className="type-body text-graphite measure-prose">
            An integration polls a board on a schedule and starts a workflow for each ticket it
            matches, on the execution profile its mappings resolve to. It spends money unattended,
            so it is created disabled, it will not enable without an owner and a prompt intro, and
            it takes itself out of circulation after repeated failures.
          </p>

          {listError === undefined ? null : <FieldError {...listError} />}

          {loaded ? null : <LoadingState>reading the integrations</LoadingState>}

          {!loaded || listError !== undefined || integrations.length > 0 ? null : (
            <EmptyState>no integrations have been created</EmptyState>
          )}

          {target === undefined ? (
            <div className="flex">
              <Button
                variant="secondary"
                onClick={() => {
                  setDraft(EMPTY_INTEGRATION)
                  setDraftErrors({})
                  setError(undefined)
                  setTarget({ kind: 'new' })
                }}
              >
                New integration
              </Button>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {target === undefined ? null : (
        <IntegrationEditor
          draft={draft}
          errors={draftErrors}
          profiles={profiles}
          owners={owners}
          editing={target.kind === 'edit'}
          now={now}
          startedAt={busyId === undefined ? startedAt : undefined}
          error={busyId === undefined ? error : undefined}
          onChange={(patch) => {
            setDraft((current) => ({ ...current, ...patch }))
          }}
          onSubmit={submitEditor}
          onCancel={() => {
            setTarget(undefined)
            setDraft(EMPTY_INTEGRATION)
            setDraftErrors({})
            setError(undefined)
          }}
        />
      )}

      {integrations.map((integration) => {
        const history = histories.get(integration.id)

        return (
          <IntegrationCard
            key={integration.id}
            integration={toIntegrationReadouts(integration, now)}
            validation={validations[integration.id]}
            startedAt={busyId === integration.id ? startedAt : undefined}
            error={busyId === integration.id ? error : undefined}
            onEdit={() => {
              setDraft(draftFromIntegration(integration))
              setDraftErrors({})
              setError(undefined)
              setTarget({ kind: 'edit', id: integration.id })
            }}
            onSetEnabled={(enabled) => {
              act(integration.id, client.setEnabled({ integrationId: integration.id, enabled }))
            }}
            onRunNow={() => {
              act(integration.id, client.runNow({ integrationId: integration.id }))
            }}
            confirmingDelete={confirmingDeleteId === integration.id}
            onRequestDelete={() => {
              setError(undefined)
              setConfirmingDeleteId(integration.id)
            }}
            onCancelDelete={() => {
              setConfirmingDeleteId(undefined)
            }}
            onConfirmDelete={() => {
              act(integration.id, client.remove({ integrationId: integration.id }))
            }}
            history={history?.rows}
            stalled={history?.stalled ?? false}
            onShowHistory={() => {
              setBusyId(integration.id)
              setStartedAt(Date.now())
              client.runs({ integrationId: integration.id }).then(
                (runs) => {
                  setHistories((current) =>
                    new Map(current).set(integration.id, {
                      rows: toRunHistory(runs),
                      stalled: looksSilentlyStalled(runs),
                    }),
                  )
                  setStartedAt(undefined)
                  setBusyId(undefined)
                  setError(undefined)
                },
                (failure: unknown) => {
                  refuse(failure)
                },
              )
            }}
            onHideHistory={() => {
              setHistories((current) => {
                const next = new Map(current)
                next.delete(integration.id)
                return next
              })
            }}
            onValidate={() => {
              setBusyId(integration.id)
              setStartedAt(Date.now())
              client.validate({ integrationId: integration.id }).then(
                (result) => {
                  setValidations((current) => ({ ...current, [integration.id]: result }))
                  setStartedAt(undefined)
                  setBusyId(undefined)
                  setError(undefined)
                },
                (failure: unknown) => {
                  refuse(failure)
                },
              )
            }}
          />
        )
      })}

      {target?.kind === 'edit' ? (
        <PromptPreview
          externalId={previewFor}
          preview={preview}
          onExternalIdChange={setPreviewFor}
          onPreview={() => {
            client.previewPrompt({ integrationId: target.id, externalId: previewFor }).then(
              (result) => {
                setPreview(result)
                setError(undefined)
              },
              (failure: unknown) => {
                setPreview(undefined)
                setError(describeFailure(failure))
              },
            )
          }}
        />
      ) : null}
    </div>
  )
}
