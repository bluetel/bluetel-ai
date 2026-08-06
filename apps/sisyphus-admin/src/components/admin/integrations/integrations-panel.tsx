'use client'

import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FieldError,
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
 * becomes a request (`integration-form-values`), how a row reads (`integration-listing`), and what
 * each control renders (`integration-card`, `integration-editor`, `credential-field`,
 * `schedule-field`, `prompt-preview`).
 *
 * ## Why it takes a client rather than calling tRPC
 *
 * `admin.integrations` is built but not yet mounted on `adminRouter`; see `integrations-client.ts`.
 * The port is the right shape regardless — it is what lets this screen be rendered and asserted on
 * without a provider, a query client or a network.
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

          {!loaded || integrations.length > 0 ? null : (
            <p className="type-data-mono text-graphite">no integrations have been created</p>
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

      {integrations.map((integration) => (
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
      ))}

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
