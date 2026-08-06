import type { IntegrationType } from '../enums'

import type { ExternalActionResult } from './external-action'

/**
 * The connector contract every integration type implements (T109, FR-192).
 *
 * ## Why it is owned here
 *
 * The control plane must depend on *this*, and never on `@bluetel-ai/sisyphus-integration-jira`.
 * FR-192 puts a hard test on that: adding a second integration type must require no change to
 * `sisyphus-api`, the control plane or the panel beyond a value in {@link IntegrationType}, its
 * migration, and a registry entry. Anything the control plane learns about Jira specifically —
 * that items have components, that discovery is a JQL query, that a comment carries a marker — is
 * a change it would have to make for the second type, so none of it appears below.
 *
 * The interface is therefore written in the vocabulary of *boards and items*, not tickets and
 * issues, and every method is expressed in terms the second type could satisfy without arguing.
 *
 * ## Two places this is more precise than `contracts/integration-connector.md`
 *
 * The design note sketches the interface; where implementing it forced a decision, this file is
 * the one that compiles and therefore the one that wins. Both differences are additive:
 *
 * 1. **`writeBack` takes the config**, like `discover` and `validate` do. A connector is a
 *    stateless value registered once per *type*, not per integration row — that is what lets one
 *    registry entry serve every Jira board. A `writeBack` without the config could not reach the
 *    board it was commenting on, so it would have forced a connector instance per row.
 * 2. **{@link CandidateItem.attributes} values may be lists.** Components and labels are
 *    genuinely multi-valued on a board, and flattening them into one delimited string would make
 *    a mapping criterion's membership test depend on parsing that string back apart. A
 *    single-valued attribute map is still assignable to this type, so nothing is lost.
 *
 * ## What a connector does not do
 *
 * It does not schedule (FR-099), does not claim (FR-102 — the unique index does that), does not
 * enforce ceilings (FR-107), does not decide ownership (FR-132: it surfaces the assignee and the
 * control plane resolves it), and does not know about workspaces, bundles or caps (FR-096 — those
 * come from the resolved profile). `discover` returns candidates and **never** starts anything.
 */

/** One comment on a candidate item, as read from the board. */
export interface ItemComment {
  readonly id: string
  /**
   * Who wrote it, in whatever form the board identifies an author — stable id for preference.
   * Carried for the record and for debugging {@link ItemComment.isPlatformAuthored}; it is not
   * what the exclusion is decided from at assembly time, because that decision has already been
   * made here.
   */
  readonly authorIdentity: string
  /**
   * Whether Sisyphus itself wrote this comment (FR-161).
   *
   * **Decided from the authoring identity, never by pattern-matching the body.** The platform
   * comments on tickets (FR-142, FR-143, FR-144) and the ticket's comments go into the next
   * prompt (FR-159); without this flag a second run on the same item reads the platform's own
   * prior write-back back in as task input, and the loop compounds on every iteration. A body
   * test would fail in both directions: a human quoting a Sisyphus comment would be excluded, and
   * a platform comment whose wording changed would be included.
   */
  readonly isPlatformAuthored: boolean
  readonly body: string
  readonly createdAt: Date
}

/**
 * An item the board says is in scope for autonomous delivery.
 *
 * A candidate, not a decision: `discover` produces these and the control plane decides what to do
 * with them.
 */
export interface CandidateItem {
  /**
   * Stable across ticks, because this is the claim key (FR-102). An item whose identifier the
   * board changes between ticks would be started twice, so a connector that cannot produce a
   * stable identifier for an item must not emit it as a candidate at all.
   */
  readonly externalId: string
  readonly title: string
  readonly url: string
  readonly body: string | null
  /** Resolves the owner, falling back to the integration's default owner (FR-132, FR-133). */
  readonly assigneeEmail: string | null
  /** Chronological, oldest first — the order FR-159 puts them in the prompt. */
  readonly comments: readonly ItemComment[]
  /**
   * What a mapping criterion may test: component, issue type, status, labels (FR-130).
   *
   * Values may be a list, for the attributes that are genuinely multi-valued.
   */
  readonly attributes: Readonly<Record<string, string | readonly string[]>>
}

/** An item the board returned that could not be represented as a candidate. */
export interface DiscoverySkip {
  /** A closed-vocabulary category, so runs can be counted by it (FR-105). */
  readonly reason: string
  /**
   * Enough to find the item by hand. **Never the item's body or title** — an integration run
   * record is not a place for customer ticket content (FR-072, FR-098).
   */
  readonly detail: string
}

export interface DiscoverContext {
  /**
   * When this integration last ran. Advisory: a connector may use it, but narrowing the query by
   * it is usually wrong, because an item deferred by a ceiling (FR-107) is never touched again
   * and would be lost from every subsequent tick (FR-108).
   */
  readonly since?: Date
  /**
   * Where an item that could not be turned into a candidate goes, so it is recorded on the run
   * rather than silently dropped (FR-105).
   */
  readonly recordSkip?: (skip: DiscoverySkip) => void
}

/**
 * One rule pairing filter criteria with an execution profile (FR-130).
 *
 * Structural, so the stored row from `integration_mappings` satisfies it without `contracts`
 * taking a dependency on the database layer — this module has to stay importable by the panel.
 */
export interface IntegrationMapping {
  readonly id: string
  /** Evaluation order. First match wins, so this is configuration rather than incidental. */
  readonly position: number
  readonly criteria: Readonly<Record<string, unknown>>
  readonly executionProfileId: string
  /** A catch-all, intended as the last entry. Still only reached in `position` order. */
  readonly isDefault: boolean
}

/**
 * What an item resolved to.
 *
 * The unmatched case carries a reason and **no profile**. There is no third state where a
 * connector guesses: running one client's ticket under another client's profile means their
 * repository, their bundle and their spend, so an unresolved item is skipped and recorded
 * (FR-130).
 */
export type MappingResolution =
  | { readonly matched: true; readonly executionProfileId: string; readonly mappingId: string }
  | { readonly matched: false; readonly reason: string }

export interface PromptContext {
  /**
   * The budget, in characters, for the comments layer of the prompt (FR-163).
   *
   * Only the comments layer, because FR-163 says the title, URL and description must never be
   * truncated away — they are the task. Comments are dropped oldest-first until the remainder
   * fits, and the number dropped is reported.
   */
  readonly maxCommentCharacters?: number
  /** A hard cap on how many comments are carried, applied after the character budget. */
  readonly maxComments?: number
}

/** The item-derived layers of the prompt, in the order FR-159 fixes. */
export interface PromptParts {
  readonly title: string
  readonly url: string
  readonly body: string | null
  /** Oldest first. Platform-authored comments are already excluded (FR-161). */
  readonly comments: readonly string[]
  /** How many comments the bound dropped, oldest-first (FR-163). */
  readonly truncatedComments: number
}

/**
 * Why an item was not started, as a closed vocabulary.
 *
 * Closed rather than free text because the reason is part of the write-back's *identity*: a
 * ticket that was skipped for having no mapping and is later skipped for a ceiling has two things
 * to say, while the same skip repeated on every tick has one. Free-text detail rides alongside
 * for the comment body, where varying it costs nothing.
 */
export type WriteBackSkipReason =
  | 'no_mapping_matched'
  | 'ceiling_reached'
  | 'integration_disabled'
  | 'empty_item'

/** What the platform has to say on an item. */
export type WriteBackEvent =
  /** A run has been started for this item (FR-142). */
  | {
      readonly kind: 'picked_up'
      readonly workflowId: string
      readonly workflowUrl: string
    }
  /** It matched the filters and nothing was started (FR-143). A labelled item is never ignored. */
  | {
      readonly kind: 'skipped'
      readonly reason: WriteBackSkipReason
      readonly detail?: string
    }
  /** A run reached a terminal outcome (FR-144). */
  | {
      readonly kind: 'outcome'
      readonly workflowId: string
      readonly outcome: string
      readonly pullRequestUrls: readonly string[]
    }

/** One thing `validate` established, or failed to. */
export interface ValidationCheck {
  readonly name: string
  readonly ok: boolean
  /**
   * Why it failed, or what it found. Safe to show an admin: never the credential and never item
   * content (FR-072, FR-098).
   */
  readonly detail?: string
}

/**
 * The gate for enabling an integration (FR-097).
 *
 * `ok` is true only when every check is. A validator that reported only on the *shape* of a
 * configuration is precisely what FR-097 rules out — a well-formed configuration pointing at an
 * unreachable board, or carrying a revoked credential, must not enable.
 */
export interface ValidationResult {
  readonly ok: boolean
  readonly checks: readonly ValidationCheck[]
}

export interface IntegrationConnector<TConfig> {
  readonly type: IntegrationType

  /**
   * Check the configuration *and reach the system it names*. The gate for enabling (FR-097).
   *
   * Never throws: an unreachable board is a failed check to show the admin, not an exception for
   * the panel to render as a stack trace.
   */
  readonly validate: (config: TConfig) => Promise<ValidationResult>

  /**
   * Every item currently matching the configured filters (FR-101).
   *
   * Returns candidates and nothing else — starting a run is the control plane's, which is what
   * lets it apply ceilings (FR-107) and claim exactly once (FR-102) around this call.
   */
  readonly discover: (config: TConfig, ctx: DiscoverContext) => Promise<readonly CandidateItem[]>

  /**
   * Ordered first-match resolution to an execution profile (FR-130).
   *
   * Deterministic and pure: the same item and the same mappings resolve the same way on every
   * tick, so why a run got its settings is explicable afterwards (FR-131).
   */
  readonly resolveProfile: (
    item: CandidateItem,
    mappings: readonly IntegrationMapping[],
  ) => MappingResolution

  /** The item-derived prompt layers, in the order FR-159 fixes, bounded per FR-163. */
  readonly assemblePromptParts: (item: CandidateItem, ctx: PromptContext) => PromptParts

  /**
   * Say something on the item (FR-142, FR-143, FR-144).
   *
   * **Idempotent.** A retry after a timeout must not leave a customer looking at two identical
   * comments from an automated system, so the action's identity is derived from what it is (see
   * `./external-action`) and the connector looks before it creates — including after a failure,
   * which is exactly the case where the remote may already hold the result.
   */
  readonly writeBack: (
    config: TConfig,
    item: CandidateItem,
    event: WriteBackEvent,
  ) => Promise<ExternalActionResult>
}
