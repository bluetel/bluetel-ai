'use client'

/* cspell:ignore lpignore */

import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import { FieldControl, FieldError, FieldLabel } from '@sisyphus-admin/components/ui'
import { useId } from 'react'

import { EDIT_CREDENTIAL_NOTICE } from './integration-form-values'

interface CredentialFieldProps {
  /** The value the admin is typing. Never seeded from the server — see below. */
  value: string
  onChange: (value: string) => void
  /** True while editing an existing integration, which changes only what the notice says. */
  editing?: boolean
  error?: FieldErrorContent
}

/**
 * The write-only credential reference (T121, FR-098).
 *
 * ## Write-only is a property of the whole path, not of this control
 *
 * Four things have to hold, and only the last two are here:
 *
 * 1. `integration-store.ts` does not select `credential_secret_arn` into anything a resolver
 *    returns, so there is no read path;
 * 2. `IntegrationView` in `integrations-client.ts` has no credential field of any kind, so a
 *    response carrying one would not type;
 * 3. `draftFromIntegration` leaves this blank when loading an existing integration, so the form
 *    state never holds a value it did not just receive from the keyboard;
 * 4. this control never receives a server value and tells the browser not to keep one.
 *
 * Remove any one of them and the credential becomes readable from the panel — and a credential you
 * can read back out of a panel is a credential you have to rotate.
 *
 * ## Why it is `password` when the value is only an ARN
 *
 * An ARN is a pointer, not a secret, so masking it is not what protects it. What masking does is
 * stop the browser, a password manager or a screen share treating this like an ordinary text field
 * — and `autoComplete="off"` with `data-lpignore` is what stops a manager offering to fill it with
 * something it saved from another form. The field an admin least wants remembered is this one.
 */
export const CredentialField = ({
  value,
  onChange,
  editing = false,
  error,
}: CredentialFieldProps) => {
  const id = useId()
  const errorId = `${id}-error`

  return (
    <div className="gap-tight flex flex-col">
      <FieldLabel htmlFor={id}>Credential secret reference</FieldLabel>
      <FieldControl
        id={id}
        type="password"
        // Never `value={integration.credentialSecretArn}` — there is no such thing to bind to.
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
        }}
        placeholder="arn:aws:secretsmanager:…"
        autoComplete="off"
        spellCheck={false}
        data-lpignore="true"
        data-1p-ignore="true"
        invalid={error !== undefined}
        aria-describedby={error === undefined ? `${id}-notice` : errorId}
      />
      <p id={`${id}-notice`} className="type-body text-graphite measure-prose">
        {editing
          ? EDIT_CREDENTIAL_NOTICE
          : 'The secret itself stays in the secret store and is read at tick time. Only the reference is stored here, and it is never returned.'}
      </p>
      {error === undefined ? null : (
        <FieldError id={errorId} code={error.code} action={error.action} />
      )}
    </div>
  )
}
