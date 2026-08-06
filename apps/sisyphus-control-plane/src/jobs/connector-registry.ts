import type { IntegrationConnector } from '@bluetel-ai/sisyphus-api/contracts'
import type { Integration } from '@bluetel-ai/sisyphus-api/db'

/**
 * The type vocabulary, taken from the column rather than restated.
 *
 * `sisyphus-api` publishes no `./enums` subpath, and a hand-written copy of the union here would be
 * a second place to add a value when a second integration type lands — which is precisely the
 * change FR-192 says adding a type must not require. Reading it off the row keeps the enum, its
 * migration and this map in step by construction.
 */
export type IntegrationType = Integration['type']

/**
 * The one place the control plane learns that integration types have implementations (FR-192).
 *
 * ## What this file does not import
 *
 * `@bluetel-ai/sisyphus-integration-jira`. Nothing under `src/jobs/` does. The control plane
 * depends on {@link IntegrationConnector} from `@bluetel-ai/sisyphus-api/contracts` and on nothing
 * else about any board, which is the test FR-192 sets: adding a second integration type must
 * require a new package, a value in {@link IntegrationType}, its migration, and **one entry here** —
 * no change to the tick, the schedule sync, the health tracker, the router or the panel.
 *
 * The registry is therefore a map the *composition root* fills in, not a module that reaches out
 * and populates itself. That is what keeps the seam a single object literal wide:
 *
 * ```ts
 * // deployment entrypoint — the only file in the control plane that names a board
 * createConnectorRegistry({
 *   jira: ({ config, credential }) =>
 *     createJiraConnector({ client: createJiraHttpClient({ baseUrl: config.baseUrl, credential }) }),
 * })
 * ```
 *
 * ## Why a factory rather than an instance
 *
 * A connector is built around a client, and a client is built around **one board's credential**,
 * read from the secret store at call time and never cached to disk (FR-072). One registry entry has
 * to serve every Jira board the platform is configured with, so what is registered is a function of
 * the integration row and its freshly-read credential.
 *
 * ## Why the config is `unknown`
 *
 * Each connector owns its own configuration schema and parses it (see `config.ts` in the Jira
 * package, and `IntegrationConnector<TConfig>`). If the control plane held a union of every type's
 * config it would be a control-plane change per type, which is exactly what FR-192 forbids. So it
 * assembles a config *shape* from the row and hands it over untyped; a config the connector cannot
 * parse fails the tick, which is recorded and retried (FR-105, FR-108), rather than widening a
 * query the admin believed was narrow.
 */

/** What the registry has to know to build a connector for one integration row. */
export interface ConnectorFactoryInput {
  /**
   * The connector's own configuration, assembled from the `integrations` row.
   *
   * Deliberately not the row itself: `credential_secret_arn`, `cron_expression`, the ceilings and
   * the schedule are the control plane's business and no connector's.
   */
  readonly config: unknown
  /**
   * The board credential, read from the secret store for this call.
   *
   * Passed to the factory rather than put on `config`, so a configuration that ends up in a log or
   * an integration run record cannot carry a token (FR-072, FR-098).
   */
  readonly credential: string
  /** Where the board lives, for the client the factory builds. */
  readonly baseUrl: string
}

export type ConnectorFactory = (input: ConnectorFactoryInput) => IntegrationConnector<unknown>

export interface ConnectorRegistry {
  /** The factory for a type, or `undefined` when this deployment has registered none. */
  readonly factoryFor: (type: IntegrationType) => ConnectorFactory | undefined
  /** Every registered type, so a deployment can report what it can actually tick. */
  readonly types: () => readonly IntegrationType[]
}

/** Thrown when a tick reaches an integration whose type nothing has been registered for. */
export const unregisteredConnectorMessage = (type: IntegrationType): string =>
  `No connector is registered for integration type ${type}. Register one in the deployment entrypoint; the control plane deliberately does not import any integration package itself (FR-192).`

/**
 * Build a registry over the entries a deployment supplies.
 *
 * @param entries - Partial on purpose: a stage may deliberately register no connector at all, and
 *   the resulting refusal is more honest than a stub that ticks nothing and reports success.
 */
export const createConnectorRegistry = (
  entries: Partial<Record<IntegrationType, ConnectorFactory>> = {},
): ConnectorRegistry => {
  // Copied, so a caller mutating the object it passed cannot change what the platform ticks after
  // start-up — a registry that could gain a type at runtime is a registry nothing can be asserted
  // about.
  const registered = new Map<IntegrationType, ConnectorFactory>(
    Object.entries(entries).map(([type, factory]) => [type as IntegrationType, factory] as const),
  )

  return {
    factoryFor: (type) => registered.get(type),
    types: () => [...registered.keys()],
  }
}

/**
 * Build the connector for one integration, or say why it cannot be built.
 *
 * @throws If the type has no registered factory. A tick that quietly did nothing for an enabled
 *   integration would look exactly like a board with no matching tickets, and the whole point of
 *   `integration_runs` is that a silently-failing connector is visible (FR-105).
 */
export const connectorFor = (
  registry: ConnectorRegistry,
  input: ConnectorFactoryInput & { readonly type: IntegrationType },
): IntegrationConnector<unknown> => {
  const factory = registry.factoryFor(input.type)

  if (factory === undefined) {
    throw new Error(unregisteredConnectorMessage(input.type))
  }

  return factory({ config: input.config, credential: input.credential, baseUrl: input.baseUrl })
}
