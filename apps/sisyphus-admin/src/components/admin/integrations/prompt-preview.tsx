'use client'

import { DataReadout } from '@sisyphus-admin/components/admin/data-readout'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FieldControl,
  FieldError,
  FieldLabel,
  StateChip,
} from '@sisyphus-admin/components/ui'
import { useId } from 'react'

import type { PromptPreviewView } from './integrations-client'

/** The fields the platform appends, stated so an author does not restate them (FR-160). */
export const APPENDED_FIELDS = ['title', 'URL', 'description', 'comments (oldest first)'] as const

interface PromptPreviewProps {
  externalId: string
  onExternalIdChange: (externalId: string) => void
  onPreview: () => void
  preview?: PromptPreviewView
  /** `Date.now()` while a preview is being fetched, or `undefined`. */
  startedAt?: number
  error?: FieldErrorContent
}

/**
 * The assembled-prompt preview (T121, FR-159, FR-160, FR-163).
 *
 * ## What it is for
 *
 * FR-160 asks the configuration interface to state **which ticket fields are appended** — title,
 * URL, description and comments — so an author writing a prompt intro does not restate them, and to
 * offer a preview of the assembled prompt for a sample ticket *before* the integration is enabled.
 * Both are here, and the first is not decorative: an intro that says "the ticket title is below"
 * costs a line of every prompt this board ever generates.
 *
 * ## The preview is the prompt
 *
 * The server renders it through the same assembler the tick uses (`previewPrompt` →
 * `PromptLayering`), so what is shown is what would be stored on the workflow row (FR-162), already
 * redacted (FR-163). A preview assembled in the browser would be a second rendering, free to differ
 * from the one that is sent — and it is the one being approved.
 *
 * The truncation notice is shown when the bound dropped comments, because a preview that silently
 * omitted them would be a preview of a different prompt.
 */
export const PromptPreview = ({
  externalId,
  onExternalIdChange,
  onPreview,
  preview,
  startedAt,
  error,
}: PromptPreviewProps) => {
  const id = useId()
  const pending = startedAt !== undefined

  return (
    <Card>
      <CardHeader>
        <span>prompt preview</span>
        <StateChip>{preview === undefined ? 'not rendered' : 'rendered'}</StateChip>
      </CardHeader>
      <CardBody className="gap-default flex flex-col">
        <p className="type-body text-graphite measure-prose">
          {`The platform appends the ticket's ${APPENDED_FIELDS.join(', ')} to every prompt this integration generates, below the execution profile's preamble and this integration's intro. There is no need to restate them in the intro.`}
        </p>

        <div className="gap-tight flex flex-col">
          <FieldLabel htmlFor={id}>Sample ticket</FieldLabel>
          <FieldControl
            id={id}
            value={externalId}
            placeholder="FIX-1"
            spellCheck={false}
            invalid={error !== undefined}
            onChange={(event) => {
              onExternalIdChange(event.target.value)
            }}
          />
        </div>

        <div className="flex">
          {pending ? (
            <Button variant="secondary" pending readout="Rendering">
              Render the prompt
            </Button>
          ) : (
            <Button variant="secondary" onClick={onPreview}>
              Render the prompt
            </Button>
          )}
        </div>

        {error === undefined ? null : <FieldError code={error.code} action={error.action} />}

        {preview === undefined ? null : (
          <div className="gap-default flex flex-col">
            <DataReadout
              label="resolved profile"
              value={
                preview.resolvedProfileId ?? `none — ${preview.resolutionReason ?? 'no match'}`
              }
            />
            {preview.truncated ? (
              <DataReadout
                label="comments dropped, oldest first"
                value={String(preview.truncatedComments)}
              />
            ) : null}
            <pre className="type-data-mono text-ink bg-paper-2 border-hairline p-close measure-prose overflow-x-auto whitespace-pre-wrap rounded-sm border">
              {preview.prompt}
            </pre>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
