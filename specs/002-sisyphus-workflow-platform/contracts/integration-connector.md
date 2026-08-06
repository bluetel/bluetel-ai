# Contract: Integration Connector

**Feature**: `specs/002-sisyphus-workflow-platform` | **Date**: 2026-08-05

One standalone package per integration type — `packages/sisyphus-integration-jira` is the only one in scope
(FR-095, FR-192). The interface is owned by `packages/sisyphus-api/src/contracts/`, so the control plane depends
on the abstraction and never on Jira.

## The interface

```ts
export interface IntegrationConnector<TConfig> {
  readonly type: IntegrationType

  /** Validate config and check connectivity. Gate for enabling. FR-097 */
  validate(config: TConfig): Promise<ValidationResult>

  /** Query for items matching the configured filters. FR-101 */
  discover(config: TConfig, ctx: DiscoverContext): Promise<CandidateItem[]>

  /** Ordered first-match resolution to an execution profile. FR-130 */
  resolveProfile(item: CandidateItem, mappings: IntegrationMapping[]): MappingResolution

  /** The ticket-derived prompt layers, in defined order. FR-159 */
  assemblePromptParts(item: CandidateItem, ctx: PromptContext): PromptParts

  /** Comment back on the item. Idempotent. FR-142, FR-143, FR-144 */
  writeBack(item: CandidateItem, event: WriteBackEvent): Promise<ExternalActionResult>
}
```

### Types

```ts
type MappingResolution =
  | { matched: true; executionProfileId: string; mappingId: string }
  | { matched: false; reason: string } // skipped, never guessed — FR-130

interface CandidateItem {
  externalId: string // stable; the claim key — FR-102
  title: string
  url: string
  body: string | null
  assigneeEmail: string | null // resolves the owner — FR-132
  comments: ItemComment[] // chronological
  attributes: Record<string, string> // component, issue type, status — mapping criteria
}

interface ItemComment {
  id: string
  authorIdentity: string
  isPlatformAuthored: boolean // excluded from assembly — FR-161
  body: string
  createdAt: Date
}

interface PromptParts {
  title: string
  url: string
  body: string | null
  comments: string[] // platform-authored already excluded
  truncatedComments: number // oldest-first drop count — FR-163
}

type WriteBackEvent =
  | { kind: 'picked_up'; workflowId: string; workflowUrl: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'outcome'; outcome: string; pullRequestUrls: string[] }
```

## Rules every connector must satisfy

| Rule                                                                      | Requirement                                                    |
| ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `externalId` is stable across ticks                                       | FR-102 — it is the claim key                                   |
| `discover` returns candidates only; **never** starts a workflow           | FR-101 — the control plane owns starting                       |
| `resolveProfile` is deterministic and first-match by `position`           | FR-130                                                         |
| No match ⇒ `{ matched: false, reason }`, never a guessed profile          | FR-130                                                         |
| Platform-authored comments excluded from `PromptParts`                    | FR-161 — otherwise Sisyphus's write-back becomes its own input |
| `writeBack` idempotent on `(item, kind)`                                  | FR-077, FR-144 — a retry must not double-comment               |
| Credentials read from the secret store at call time, never cached to disk | FR-072                                                         |
| Never logs its credential or the item body verbatim                       | FR-072                                                         |
| `validate` performs a real connectivity check                             | FR-097 — a config that cannot reach the system must not enable |

**The exclusion rule is the subtle one.** FR-142/FR-144 make Sisyphus comment on tickets; FR-159 puts ticket
comments into the prompt. Without `isPlatformAuthored`, a second run on the same ticket reads Sisyphus's own
prior comments back as task input, and the loop compounds each iteration. `isPlatformAuthored` must be determined
from the authoring identity, not by pattern-matching the comment text.

## What the connector does **not** do

- **Does not schedule.** The control plane registers and re-registers schedules (FR-099, FR-100).
- **Does not claim.** The control plane writes the claim in the same transaction that creates the workflow, and
  the unique index — not connector logic — is what makes exactly-once hold (FR-102).
- **Does not enforce ceilings.** Per-tick and rolling-period ceilings are the control plane's (FR-107).
- **Does not decide ownership.** It surfaces `assigneeEmail`; the control plane resolves owner, falling back to
  the integration's default owner (FR-132, FR-133).
- **Does not know about workspaces, bundles or caps.** Those come from the resolved profile (FR-096).

## Control-plane tick

```
1. Load enabled integration + mappings
2. If a previous tick is still running → skip or coalesce, record it        FR-103
3. connector.discover(config, { since: lastRunAt })
4. For each candidate, in order:
   a. connector.resolveProfile → no match ⇒ record skip + writeBack('skipped')   FR-130, FR-143
   b. Ceiling reached ⇒ record skip + writeBack('skipped'); defer to a later tick FR-107
   c. Empty title AND body ⇒ record skip + writeBack('skipped')                  FR-164
   d. INSERT claim + INSERT workflow in one transaction
      → unique violation ⇒ already claimed; no comment (already commented on first claim)  FR-102, FR-143
   e. connector.assemblePromptParts → assemble with the profile preamble + the integration intro (FR-157, FR-158) → store as sent  FR-159, FR-162
   f. writeBack('picked_up')                                                     FR-142
5. Record the integration run: examined / matched / started / skipped + reasons   FR-105
6. On failure: increment consecutive failures; auto-disable past threshold        FR-106, FR-108
```

**Two integrations matching one ticket** ⇒ exactly one workflow starts; the winner is deterministic (lowest
`integrations.id`) and independent of tick timing, with the ambiguity recorded on the losing run (FR-104).

## Adding a second type

Must require **no change** to `sisyphus-api`, the control plane or the panel beyond registering the new package
in the connector registry (FR-192). Concretely: a new type adds a package, a value to the `IntegrationType`
enum, a migration for that enum, and a registry entry. If a second type would need a control-plane change, the
interface above is wrong and should be fixed rather than worked around.

## The Jira implementation

| Aspect               | Approach                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Discovery            | JQL scoped by project prefix + configured label + extra filters; paginated                                                   |
| Credential           | API token from Secrets Manager, referenced by ARN on the integration row; write-only from the panel (FR-098)                 |
| `isPlatformAuthored` | Comment author matches the configured Sisyphus service account                                                               |
| `attributes`         | Component, issue type and status, exposed as mapping criteria                                                                |
| Transitions          | Performed by the **executor** following the repository's skills, not by the connector (FR-057) — the connector only comments |
| Idempotency          | A marker in the comment body keyed to `(workflowId, kind)`, checked before posting                                           |

Jira transitions are deliberately not the connector's job: which transition to apply is skill-defined per client
(FR-057), and the connector must not encode any client's workflow.
