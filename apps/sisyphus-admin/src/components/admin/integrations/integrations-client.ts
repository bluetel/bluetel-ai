import type { IntegrationType } from '@bluetel-ai/sisyphus-api/client'

/**
 * What the integrations screen needs from the server, as a port (T121).
 *
 * ## Why a port rather than `api.admin.integrations` directly
 *
 * `admin.integrations` is built (`packages/sisyphus-api/src/server/admin/integrations.ts`) and is
 * **not yet mounted on `adminRouter`** — mounting it is a one-line change to a barrel this work was
 * asked to leave alone. Until it is, `api.admin.integrations` does not exist on `AppRouter`, so a
 * screen written directly against it would not compile.
 *
 * A port is the right answer regardless of that, and would have been worth having anyway: the
 * screen can then be rendered in a test with no tRPC provider, no query client and no network,
 * which is what lets every assertion below run under `renderToStaticMarkup`. Wiring it up is one
 * adapter — see {@link IntegrationsClient} — and the shapes are stated here rather than inferred
 * only because `RouterOutputs` cannot reach an unmounted router.
 *
 * **When the router is mounted**, replace {@link createUnavailableIntegrationsClient} in
 * `page.tsx` with an adapter over `api.admin.integrations`, and these interfaces can be narrowed to
 * `RouterOutputs['admin']['integrations'][…]`.
 */

/** One mapping, as the panel shows and edits it. */
export interface IntegrationMappingView {
  readonly id: string
  readonly position: number
  readonly criteria: Readonly<Record<string, unknown>>
  readonly executionProfileId: string
  readonly executionProfileName: string | null
  readonly isDefault: boolean
}

/** The last tick, as the panel shows it. */
export interface IntegrationRunView {
  readonly id: string
  readonly trigger: 'scheduled' | 'manual'
  readonly startedAt: Date
  readonly endedAt: Date | null
  readonly examinedCount: number
  readonly matchedCount: number
  readonly startedCount: number
  readonly skippedCount: number
  readonly error: string | null
}

/**
 * One integration, as the panel receives it.
 *
 * **No credential field, of any kind.** Not `credentialSecretArn`, not a masked version, not a
 * "hasCredential" boolean that a later change could turn into a value. The server does not return
 * one (FR-098) and this type is the panel's statement of that fact — if a credential ever appears
 * in a response, this type is where the mismatch surfaces.
 */
export interface IntegrationView {
  readonly id: string
  readonly type: IntegrationType
  readonly name: string
  readonly baseUrl: string
  readonly projectPrefix: string
  readonly label: string
  readonly extraFilters: Readonly<Record<string, unknown>> | null
  readonly defaultOwnerUserId: string | null
  readonly promptIntro: string
  readonly cronExpression: string
  readonly timezone: string
  readonly perTickCeiling: number
  readonly rollingPeriodCeiling: number
  readonly rollingPeriodMinutes: number
  readonly enabled: boolean
  readonly consecutiveFailures: number
  readonly autoDisabledReason: string | null
  readonly scheduleArn: string | null
  readonly mappings: readonly IntegrationMappingView[]
  readonly claimedTicketCount: number
  readonly startedWorkflowCount: number
  readonly lastRun: IntegrationRunView | undefined
}

/** What `validate` answers with (FR-097). */
export interface ValidationView {
  readonly ok: boolean
  readonly checks: readonly {
    readonly name: string
    readonly ok: boolean
    readonly detail?: string
  }[]
}

/** What `previewPrompt` answers with (FR-160). */
export interface PromptPreviewView {
  readonly prompt: string
  readonly truncated: boolean
  readonly truncatedComments: number
  readonly resolvedProfileId: string | undefined
  readonly resolutionReason: string | undefined
}

/** What the editor submits. Mirrors `createIntegrationInput`; the credential is write-only. */
export interface IntegrationSubmission {
  readonly name: string
  readonly baseUrl: string
  readonly credentialSecretArn: string
  readonly projectPrefix: string
  readonly label: string
  readonly extraFilters: Record<string, unknown> | null
  readonly defaultOwnerUserId: string | null
  readonly promptIntro: string
  readonly cronExpression: string
  readonly timezone: string
  readonly perTickCeiling: number
  readonly rollingPeriodCeiling: number
  readonly rollingPeriodMinutes: number
  readonly mappings: readonly {
    readonly position: number
    readonly criteria: Record<string, unknown>
    readonly executionProfileId: string
    readonly isDefault: boolean
  }[]
}

export interface IntegrationsClient {
  readonly list: () => Promise<readonly IntegrationView[]>
  readonly create: (
    input: IntegrationSubmission & { readonly type: IntegrationType },
  ) => Promise<void>
  readonly update: (
    input: IntegrationSubmission & { readonly integrationId: string },
  ) => Promise<void>
  readonly setEnabled: (input: {
    readonly integrationId: string
    readonly enabled: boolean
  }) => Promise<void>
  readonly validate: (input: { readonly integrationId: string }) => Promise<ValidationView>
  readonly runNow: (input: { readonly integrationId: string }) => Promise<void>
  readonly previewPrompt: (input: {
    readonly integrationId: string
    readonly externalId: string
  }) => Promise<PromptPreviewView>
}

export const INTEGRATIONS_UNAVAILABLE =
  'The integrations API is not mounted in this deployment, so this screen has nothing to read.'

/**
 * The client used before `admin.integrations` is mounted.
 *
 * It reports the absence rather than rendering an empty screen. An admin looking at a list of zero
 * integrations would conclude none are configured, which is a different — and worse — statement
 * than "this deployment cannot answer".
 */
export const createUnavailableIntegrationsClient = (): IntegrationsClient => {
  const refuse = <TResult>(): Promise<TResult> =>
    Promise.reject(new Error(INTEGRATIONS_UNAVAILABLE))

  return {
    list: refuse,
    create: refuse,
    update: refuse,
    setEnabled: refuse,
    validate: refuse,
    runNow: refuse,
    previewPrompt: refuse,
  }
}
