import { z } from 'zod'

/**
 * What this connector needs to be told about one Jira board.
 *
 * Assembled by the control plane from the `integrations` row and the secret store; nothing here is
 * read from the environment, and **the credential is not part of it** — it reaches the
 * {@link import('./client').JiraRestClient} implementation directly, so a config that ends up in a
 * log or an integration run record cannot carry a token (FR-072, FR-098).
 *
 * What is *not* here is as deliberate: no repository, branch, model, caps or bundle. Those come
 * from the execution profile the mapping resolves to (FR-096), and restating them on the board
 * would mean two places to change and one of them silently wrong.
 */

const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), {
    message: 'Jira base URL must be https — a plaintext base URL sends the credential in clear.',
  })

/**
 * Extra board-side filtering (FR-096): a field name against one value or a set of them.
 *
 * Strict on purpose. `extra_filters` is `jsonb`, so anything at all can be stored there, and a
 * connector that quietly ignored a filter it did not understand would *widen* the query — it would
 * start paid runs on tickets an admin believed were excluded. A filter it cannot parse fails the tick
 * instead, which is recorded and retried (FR-105, FR-108).
 */
export const jiraExtraFilters = z.record(
  z.string().min(1),
  z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
)

/**
 * The identity Sisyphus comments as.
 *
 * Optional, and the fallback matters: when it is absent the platform identity is whoever the
 * credential authenticates as (`./platform-identity`). Setting it explicitly is what keeps FR-161
 * holding across a credential rotation — comments posted by the old account are still recognised
 * as the platform's own, and so still kept out of the next prompt.
 */
export const jiraServiceAccount = z.object({
  accountId: z.string().min(1).optional(),
  emailAddress: z.string().min(1).optional(),
})

export const jiraIntegrationConfigSchema = z.object({
  baseUrl: httpsUrl,
  /** The project key discovery is scoped to. */
  projectPrefix: z.string().min(1),
  /** The label that marks a ticket for autonomous delivery (FR-096). */
  label: z.string().min(1),
  extraFilters: jiraExtraFilters.nullish(),
  serviceAccount: jiraServiceAccount.nullish(),
  /** Jira caps a page at 100; asking for more is silently reduced, so it is capped here. */
  pageSize: z.number().int().positive().max(100).default(50),
  /**
   * How many candidates one tick will read before it stops paging.
   *
   * A bulk label application across a board can match thousands of tickets; discovery is not the
   * ceiling that stops those turning into paid compute (FR-107 is, in the control plane), but an
   * unbounded paging loop is its own denial of service. Stopping early loses nothing: unclaimed
   * tickets still match on the next tick (FR-108).
   */
  maxItemsPerTick: z.number().int().positive().default(500),
})

/** What a caller passes: defaults unapplied. */
export type JiraIntegrationConfig = z.input<typeof jiraIntegrationConfigSchema>

/** What the connector works with: every default settled. */
export type ResolvedJiraConfig = z.output<typeof jiraIntegrationConfigSchema>

export type JiraServiceAccount = z.output<typeof jiraServiceAccount>

/**
 * @throws {z.ZodError} If the configuration is unusable. Callers that must not throw — `validate`
 * — catch it and report it as a failed check.
 */
export const resolveJiraConfig = (config: JiraIntegrationConfig): ResolvedJiraConfig =>
  jiraIntegrationConfigSchema.parse(config)

/** The same parse, as an answer rather than an exception. */
export const parseJiraConfig = (
  config: unknown,
): z.SafeParseReturnType<JiraIntegrationConfig, ResolvedJiraConfig> =>
  jiraIntegrationConfigSchema.safeParse(config)
