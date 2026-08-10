# Contract: API Surface (`packages/sisyphus-api`)

**Feature**: `specs/002-sisyphus-workflow-platform` | **Date**: 2026-08-05

One tRPC definition, three consumption modes (R4). Zod validates every input; validation failures are flattened
into `data.zodError` so the panel renders them field-by-field (FR-008).

## Consumption modes

| Consumer                 | Mode                | Mechanism                                            | Reaches resolvers? | Reaches DB? |
| ------------------------ | ------------------- | ---------------------------------------------------- | ------------------ | ----------- |
| `sisyphus-admin`         | Server              | Route handler mounts `appRouter`                     | Yes                | Yes         |
| `sisyphus-control-plane` | In-process caller   | `createCallerFactory(appRouter)`                     | Yes                | Yes         |
| `sisyphus-executor`      | Typed remote client | `createTRPCClient<AppRouter>` — **type-only import** | No                 | No          |

The executor's type-only import is a hard boundary, not a convention: no resolver code and no database driver is
bundled onto the instance, so a compromised setup bundle cannot reach the database (FR-005, FR-006).

## Package entry points — the boundary is the exports map

`sisyphus-api` declares **no root `.` export**. Each consumption mode gets its own subpath, so the boundary above
is a build-time fact rather than a review convention:

| Subpath       | Contains                                                                      | Safe in a browser bundle? |
| ------------- | ----------------------------------------------------------------------------- | ------------------------- |
| `./server`    | `appRouter`, resolvers, `createTRPCContext`, `createCaller`, Drizzle + driver | **No**                    |
| `./client`    | `AppRouter` **type**, `RouterInputs`/`RouterOutputs`, input schemas, enums    | Yes                       |
| `./contracts` | Connector interface, executor protocol types — types only                     | Yes                       |
| `./db`        | Schema and migrations, for migration tooling only                             | **No**                    |

Without this, a single root barrel puts `postgres`, Drizzle and every resolver one import away from a panel
client component — and the FR-005 boundary the executor relies on becomes unenforced. Each subpath is still a
directory with its own `index.ts` barrel, so constitution gate II holds; what is removed is only the **root**
barrel that would collapse the four into one.

## Setup factory

The factory is defined in this package (`router/trpc.ts`) rather than imported, and its additional-context hook
is **async** — resolving a session and a permitted-profile set both require awaits:

```ts
export const { t, createTRPCContext, createCallerFactory, createTRPCRouter, publicProcedure } =
  createTRPCSetup({
    createAdditionalContext: async ({ headers }) => ({
      db,
      session: await resolveSession(headers),
      // NOT a resolved array — a memoised resolver, so unauthenticated and
      // machine-surface requests never pay for a grants query (FR-190)
      scope: memoiseScope(),
    }),
  })
```

`superjson` as the transformer (so `Date` and `numeric` survive the wire). `errorFormatter` flattens `ZodError`.

**Why async matters.** A synchronous additional-context hook cannot await the session lookup or the grant query,
so the scope would have to be re-derived inside each resolver — which is exactly the per-resolver duplication
FR-190 cannot survive. `fetchRequestHandler` and `createCallerFactory` both accept a promise-returning context
creator, so async costs nothing structurally.

**Why memoised rather than resolved.** Every request would otherwise query `profile_access_grants`, including
health checks and the executor's high-frequency machine calls, none of which consult the scope.

## Input schemas live with the contract

Input schemas are exported from `./client` and consumed by both sides — the resolver's `.input()` and the panel's
form — so the two cannot drift:

```ts
export const startWorkflowInput = z.object({
  executionProfileId: z.string().uuid(),
  prompt: z.string().min(1),
})
// resolver:  .input(startWorkflowInput)
// panel:     useForm({ resolver: zodResolver(startWorkflowInput) })
```

This is what makes the flattened `data.zodError` useful: field-level rendering needs the client to know the same
field names the server validated. Applies to the launch form (FR-016, FR-122), bundle registration (FR-085),
integration configuration (FR-096) and prompt preview (FR-160).

## Type inference helpers

`RouterInputs` and `RouterOutputs` (via `inferRouterInputs`/`inferRouterOutputs`) are exported from `./client` and
are the **only** sanctioned way to type anything API-derived. Hand-written DTOs mirroring a procedure's return
type are a defect — they are duplication the qlty gate will flag, and they drift silently.

## Procedure types

| Procedure          | Guarantees                                                                                        | Used by                    |
| ------------------ | ------------------------------------------------------------------------------------------------- | -------------------------- |
| `publicProcedure`  | None                                                                                              | Health check only          |
| `authedProcedure`  | Active user session; sets `ctx.user`                                                              | Interactive surface        |
| `adminProcedure`   | `authedProcedure` + `role = 'admin'`; denial recorded                                             | All configuration (FR-169) |
| `scopedProcedure`  | `authedProcedure` + `ctx.scope` (visible profile ids + own-workflow clause)                       | Every workflow read        |
| `machineProcedure` | Valid workflow-scoped credential; sets `ctx.workflowId`; **rejects any interactive-surface path** | Executor report-back       |

**`scopedProcedure` is where FR-190 is enforced.** It awaits the caller's visible profile set once and exposes
a base selector every workflow query composes from. A resolver that builds its own `where` from scratch is a
review failure — the scoping must not be re-derivable per resolver, because the leak is silent (see
[data-model.md → Access scoping](../data-model.md#access-scoping)).

## Interactive surface — `appRouter`

Mounted at `/api/trpc`. Requires a human session.

### `workflow`

| Procedure                   | Type                  | Input                                                                                          | Authorisation                      | Requirements                     |
| --------------------------- | --------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------- |
| `list`                      | query                 | filters (initiator, integration, status, type, workspace, repository, profile, bundle), cursor | `scopedProcedure`                  | FR-012, FR-013, FR-190           |
| `byId`                      | query                 | `{ workflowId }`                                                                               | `scopedProcedure`                  | FR-014                           |
| `timeline`                  | query                 | `{ workflowId }`                                                                               | `scopedProcedure`                  | FR-014, FR-064                   |
| `logSegments`               | query                 | `{ workflowId, fromSequence }`                                                                 | `scopedProcedure`                  | FR-046                           |
| `logStream`                 | SSE (route, not tRPC) | `{ workflowId }`                                                                               | `scopedProcedure`                  | FR-046, R6                       |
| `spendSummary`              | query                 | grouping (client / workspace / profile / user)                                                 | `scopedProcedure`                  | FR-156, SC-051                   |
| `needsAttention`            | query                 | —                                                                                              | `authedProcedure`                  | FR-135                           |
| `start`                     | mutation              | job spec **or** `{ executionProfileId, prompt, overrides?, resumeFromSessionId? }`             | `authedProcedure` + profile grant  | FR-016, FR-122, FR-180           |
| `startAdHoc`                | mutation              | full job spec                                                                                  | `adminProcedure`                   | FR-129, FR-187                   |
| `pause` / `resume` / `stop` | mutation              | `{ workflowId }`                                                                               | `scopedProcedure` (own-or-granted) | FR-015, FR-049, FR-182           |
| `correct`                   | mutation              | `{ workflowId, body }`                                                                         | `scopedProcedure`                  | FR-015, FR-049                   |
| `continueWithChanges`       | mutation              | `{ workflowId, caps?, model? }`                                                                | `scopedProcedure`                  | FR-150 — creates a **successor** |
| `reassignOwner`             | mutation              | `{ workflowId, ownerUserId }`                                                                  | `adminProcedure`                   | FR-134                           |
| `watch` / `unwatch`         | mutation              | `{ workflowId }`                                                                               | `scopedProcedure`                  | FR-138, FR-190                   |
| `artifacts`                 | query                 | `{ workflowId }`                                                                               | `scopedProcedure`                  | FR-014, SC-012                   |
| `skillReferences`           | query                 | `{ workflowId }`                                                                               | `scopedProcedure`                  | FR-059, SC-016                   |
| `notificationPreferences`   | query + mutation      | `{ event, enabled }`                                                                           | `authedProcedure`                  | FR-138                           |

**Rules.** `start` refuses a profile the caller does not hold and records the attempt (FR-180). Supervision
mutations serialise on the workflow row so two corrections are delivered exactly once in submission order
(FR-049), and are refused against a terminal workflow with an already-finished response (FR-081).
`continueWithChanges` never edits the predecessor's job spec (FR-149).

**`start` is idempotent under a duplicate request** (FR-078). Two concurrent starts for the same workflow
provision at most one instance: admission takes the `compute_leases` partial unique index, and the loser returns
the existing workflow rather than an error — a double-clicked launch button is a duplicate request, not a
failure. `start` may also return a **queued** workflow rather than a provisioning one when the platform
concurrency ceiling is reached (FR-040); the response carries the queue position, so the caller can distinguish
"waiting" from "stuck".

**`start` accepts an optional session reference** (`resumeFromSessionId`), which FR-016 requires explicitly and
US3 depends on — restoring a stored session into a **new** workflow is a different operation from continuing an
existing one by id, and only the latter was modelled. The referenced snapshot must be unexpired and within the
caller's scope, or the request is refused with the retention limit stated.

**`watch` is scoped like a read.** It uses `scopedProcedure`, so a user cannot watch — and therefore cannot
confirm the existence of — a workflow outside their permitted scope, and an out-of-scope target returns
`NOT_FOUND` for the same reason every other out-of-scope read does (FR-190).

### `admin` — all `adminProcedure`

| Sub-router     | Procedures                                                                                                       | Requirements                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `bundles`      | `list`, `register`, `replaceArchive`, `updateMetadata`, `setEnabled`, `references`, `validate`, `validationRuns` | FR-084..FR-086, FR-090..FR-092, FR-147, FR-148, FR-167, FR-168 |
| `workspaces`   | `list`, `create`, `update`, `clone`, `setEnabled`, `references`                                                  | FR-109..FR-111, FR-125, FR-127                                 |
| `profiles`     | `list`, `create`, `update`, `clone`, `setEnabled`, `references`                                                  | FR-121..FR-128                                                 |
| `grants`       | `listForProfile`, `listForUser`, `grant`, `revoke`                                                               | FR-179, FR-184, FR-188                                         |
| `integrations` | `list`, `create`, `update`, `setEnabled`, `delete`, `runNow`, `runs`, `validate`, `previewPrompt`                | FR-096..FR-098, FR-105..FR-107, FR-130, FR-158, FR-160, FR-186 |
| `users`        | `list`, `setRole`, `setActive`, `roleChanges`                                                                    | FR-171..FR-173, FR-175..FR-177                                 |

**Rules.** `bundles.list` is the one exception to admin-only: any authenticated user may read the **enabled**
list, because selecting a bundle is part of building a profile (FR-086). `profiles.setEnabled(true)` runs the
FR-124 validation gate — published version present, pinned rows readable, bundle enabled and unarchived,
workspace unarchived and non-empty — and refuses naming every failing element. It makes **no** outbound call:
repository reachability is not checked (`specs/004-remove-reachability-gate`).
`profiles.setEnabled(false)` is unconditional and never runs the gate. `integrations.previewPrompt` renders the assembled prompt for a sample ticket before enable (FR-160).
`users.setRole` / `setActive` re-count active admins inside the transaction so the never-zero-admins invariant
cannot race (FR-173).

## Machine surface — `machineRouter`

Mounted at `/api/machine`. Requires a workflow-scoped credential; **an executor credential grants nothing on
the interactive surface** (FR-005).

| Procedure                | Input                                                                                        | Requirements           |
| ------------------------ | -------------------------------------------------------------------------------------------- | ---------------------- |
| `heartbeat`              | `{ state, turnsUsed, spendUsed }`                                                            | FR-048                 |
| `reportBootstrapPhase`   | `{ phase, entryId?, outcome, detail? }`                                                      | FR-145, FR-146         |
| `appendLogSegment`       | `{ sequence, s3Key, byteSize, startedAt, endedAt }`                                          | FR-046                 |
| `registerSnapshot`       | `{ sessionId, s3Key, boundary, hasConversationState, hasWorktreeState, truncationRepaired }` | FR-050, FR-053         |
| `pullPendingCorrections` | —                                                                                            | FR-049                 |
| `pullPendingCommands`    | —                                                                                            | FR-049, SC-003         |
| `acknowledgeCommand`     | `{ commandId, outcome, failureReason? }`                                                     | FR-049, FR-081         |
| `reportSkillReference`   | `{ skillName, entryId, resolvedPath, contentDigest, phase }`                                 | FR-058, FR-059, SC-016 |
| `registerArtifact`       | `{ entryId?, kind, s3Key?, externalUrl?, byteSize? }`                                        | FR-014, SC-012         |
| `acknowledgeCorrection`  | `{ correctionId, outcome, failureReason? }`                                                  | FR-049                 |
| `reportEntryResult`      | `{ entryId, resolvedCommit, wasChanged, pullRequestUrl?, entryResult }`                      | FR-114, FR-115, FR-118 |
| `reportExternalAction`   | `{ kind, targetReference, idempotencyKey, result, attemptCount }`                            | FR-076, FR-077         |
| `reportIteration`        | `{ ordinal, verdict, findings[] }`                                                           | FR-062, FR-063, FR-119 |
| `reportReviewerSummary`  | `{ summary }`                                                                                | FR-153                 |
| `reportTerminal`         | `{ outcome, reason, turnsUsed, spendUsed }`                                                  | FR-056, FR-064         |
| `renewCredential`        | —                                                                                            | FR-037                 |

**`pullPendingCommands` is the missing half of supervision.** The panel's `pause` mutation writes a row; without
this procedure nothing on the instance ever reads it, `suspend()` is specified but never invoked, and SC-003's
10-second pause is unreachable. Commands are returned in `sequence` order and acknowledged like corrections; a
`pause` overtaken by a `stop` before collection comes back already marked `superseded`, so the executor never
applies a command the user has replaced. The panel reports "paused" only once the executor has acknowledged —
otherwise the UI would claim a pause the instance has not performed.

**Rules.** Every write is scoped to `ctx.workflowId`; a write naming another workflow is denied and recorded as a
security event (FR-018, SC-014). `appendLogSegment` is idempotent on `(workflowId, sequence)` so a retry
after a network failure cannot duplicate. The executor MUST NOT reach a terminal state without calling
`reportTerminal` — the reconciler catches the case where it dies first (FR-056).

## Route handlers

Both surfaces mount through `fetchRequestHandler`. `onError` is gated on the development environment, read from
the validated `env` module rather than `process.env` directly:

```ts
onError: env.NEXT_PUBLIC_NODE_ENV === 'development'
  ? ({ path, error }) => {
      /* log */
    }
  : undefined
```

**This gate is load-bearing on the machine surface.** An unconditional `onError` writes executor-reported content
into platform logs, which sits outside the FR-045 sanitisation the executor applies on its own side — so the one
place output is guaranteed clean would be bypassed by the error path.

## Webhook ingress

`POST /api/webhook` — signature-verified, replay-rejecting, outside tRPC because the payload shape is the
provider's (FR-017). Verifies before parsing, and never trusts the body to name the integration.

## Error mapping

| Condition                    | tRPC code      | Notes                                                                                   |
| ---------------------------- | -------------- | --------------------------------------------------------------------------------------- |
| Not signed in                | `UNAUTHORIZED` | No workflow data in the message (FR-011); a deactivated user fails here (FR-175)        |
| Signed in, wrong role        | `FORBIDDEN`    | Reason stated; attempt recorded (FR-169, FR-180)                                        |
| Outside visible scope        | `NOT_FOUND`    | **Deliberately not `FORBIDDEN`** — `FORBIDDEN` confirms existence, which FR-190 forbids |
| Invalid input                | `BAD_REQUEST`  | `data.zodError` flattened for field-level rendering (FR-008)                            |
| Terminal-state action        | `CONFLICT`     | Already-finished response (FR-081)                                                      |
| Concurrent transition        | `CONFLICT`     | Row lock lost (FR-049)                                                                  |
| Cross-workflow machine write | `FORBIDDEN`    | Recorded as a security event (FR-018)                                                   |

The `NOT_FOUND`-for-out-of-scope choice is the single most easily-broken rule in this contract: the intuitive
`FORBIDDEN` is a disclosure. It belongs in the contract tests, not in review vigilance.
