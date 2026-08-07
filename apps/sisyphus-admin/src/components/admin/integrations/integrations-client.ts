import type { IntegrationType } from '@bluetel-ai/sisyphus-api/client'

/**
 * What the integrations screen needs from the server, as a port (T121, T199).
 *
 * ## Why a port rather than `api.admin.integrations` directly
 *
 * `admin.integrations` is mounted on `adminRouter`, and {@link IntegrationsClient} is implemented
 * over it by `api-integrations-client.ts` — so the indirection is now a choice rather than a
 * workaround, and it is kept for the reason it was worth having in the first place: the screen can
 * be rendered in a test with no tRPC provider, no query client and no network, which is what lets
 * every assertion on its parts run under `renderToStaticMarkup`.
 *
 * ## Why these shapes are written out rather than `RouterOutputs[…]`
 *
 * The repo's rule is to type API-derived values from `RouterOutputs`, and this file is the
 * exception on purpose. {@link IntegrationView} is the screen's **statement** that no credential
 * reaches it — an alias to the router's row would make that statement whatever the router happened
 * to return this week. The two are held together instead by `integration-view.ts`, where the
 * mapping from one to the other is written once and the credential's absence is asserted at
 * compile time.
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
  /**
   * Remove a board that has never started anything (FR-097).
   *
   * The server decides whether it may go: an integration a workflow points at cannot be deleted
   * without making that run unexplainable (FR-131), and it refuses with the counts. The screen does
   * not pre-judge that — see the note on the panel's delete flow.
   */
  readonly remove: (input: { readonly integrationId: string }) => Promise<void>
  /**
   * The tick history, beyond the last one (FR-105).
   *
   * Read on demand rather than with the list: FR-105 asks for the history to be *visible*, and
   * fifty correlated run queries on page load is a different thing from that.
   */
  readonly runs: (input: {
    readonly integrationId: string
  }) => Promise<readonly IntegrationRunView[]>
  readonly previewPrompt: (input: {
    readonly integrationId: string
    readonly externalId: string
  }) => Promise<PromptPreviewView>
}

/**
 * There was a `createUnavailableIntegrationsClient` here, and it is deliberately gone (T199).
 *
 * It refused every call with "the integrations API is not mounted in this deployment", which was
 * true while the router was unmounted and became a lie the moment it was not. A fallback that
 * reports an unavailability the deployment does not have is worse than no fallback: it tells an
 * admin the platform cannot answer when what actually happened was a request that failed. Real
 * failures now surface as themselves, through `describeFailure` in `integrations-panel.tsx`.
 */
