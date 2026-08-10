import type { IntegrationConnector, PromptParts } from '../../contracts'
import type { IntegrationType } from '../../enums'

/**
 * The two outbound seams `admin.integrations` needs, as ports rather than implementations.
 *
 * `validate` has to *reach the board* — a well-formed configuration pointing at an unreachable
 * system must not enable (FR-097) — and `previewPrompt` has to read a real ticket and render what
 * the agent would actually be told (FR-160). Both are network calls, and a network call reached
 * directly from a resolver is a resolver no test can exercise.
 *
 * These two seams are worth having because a deployment can actually supply them: the board
 * credential is held by the platform, so the check `validate` makes is the same check the run will
 * later depend on. Contrast the repository-reachability seam FR-124 once carried, which was removed
 * (`specs/004-remove-reachability-gate`) because the credential it needed lives only on the
 * executor instance and never reaches here — a port nobody can implement is not a seam, it is a
 * refusal with extra steps.
 *
 * ## Neither port names a board (FR-192)
 *
 * `sisyphus-api` owns the connector contract; it must never depend on an implementation of it.
 * {@link IntegrationConnectorRegistry} is keyed by {@link IntegrationType}, so a second integration
 * type is a package and a registry entry in the deployment's composition root — not a change here,
 * not a change in the control plane, and not a change in the panel.
 *
 * ## Why prompt *assembly* is a port too
 *
 * Layering the prompt (FR-157 → FR-158 → the ticket) and redacting it to the run-output standard
 * (FR-163) both live in the control plane, where the assembled prompt has to exist before the
 * workflow row does. The panel's preview must show **that** prompt, not a second rendering of it —
 * a preview an admin approves which differs from what is sent is worse than no preview. So the
 * router is handed the same function the tick uses rather than reimplementing it.
 */

/** What the registry needs to build a connector for one integration row. */
export interface ConnectorRequest {
  readonly type: IntegrationType
  /** Assembled from the row: where the board is, what to look at, what marks an item. */
  readonly config: unknown
  /** Which secret holds the credential. The value is read by the adapter, never by this package. */
  readonly credentialSecretArn: string
  readonly baseUrl: string
}

export interface IntegrationConnectorRegistry {
  /** `undefined` when this deployment has registered no connector for that type. */
  readonly connectorFor: (
    request: ConnectorRequest,
  ) => Promise<IntegrationConnector<unknown> | undefined>
}

/** The reason given when no connector has been wired into the deployment. */
export const CONNECTOR_NOT_CONFIGURED_REASON =
  'this deployment has no connector registered for that integration type, so its configuration cannot be checked against the system it names'

/**
 * The registry used when a deployment has wired none: it produces nothing.
 *
 * Every `validate` then fails its connectivity check and every `setEnabled(true)` is refused, which
 * is the safe default rather than an inconvenient one. FR-097 exists to stop an integration that
 * cannot reach its board being enabled; a registry that answered "fine" when it had checked nothing
 * would turn the gate into a formality while leaving it looking present.
 */
export const createRefusingConnectorRegistry = (): IntegrationConnectorRegistry => ({
  connectorFor: () => Promise.resolve(undefined),
})

/** What a preview shows an admin before the integration is enabled (FR-160). */
export interface AssembledPromptPreview {
  /** Exactly what would be sent, and exactly what would be stored (FR-162). */
  readonly prompt: string
  readonly truncated: boolean
  readonly truncatedComments: number
}

export interface PromptLayeringInput {
  /** The execution profile's preamble, where the mapping resolved to one (FR-157). */
  readonly preamble: string | null
  /** The integration's prompt intro (FR-158). */
  readonly intro: string
  /** The ticket layers, from the connector. */
  readonly parts: PromptParts
}

/**
 * Lays the prompt out and redacts it — the control plane's `assembleIntegrationPrompt`.
 *
 * A port, so the panel renders the *same* function the tick does. Wire it in the composition root.
 */
export interface PromptLayering {
  readonly assemble: (input: PromptLayeringInput) => AssembledPromptPreview
}

export const PROMPT_LAYERING_NOT_CONFIGURED =
  'This deployment has wired no prompt assembler, so a preview cannot be rendered to the standard the stored prompt is held to (FR-163). Supply the control plane assembler.'

/**
 * The assembler used when a deployment has wired none: it refuses.
 *
 * Not a plain concatenation fallback. A preview is read by an admin and may be pasted into a
 * ticket, so an unredacted one is a disclosure — and one that differed from what the tick sends
 * would be worse than useless, because it is the thing being approved.
 */
export const createRefusingPromptLayering = (): PromptLayering => ({
  assemble: () => {
    throw new Error(PROMPT_LAYERING_NOT_CONFIGURED)
  },
})
