# Implementation Plan: Sisyphus — Supervised & Autonomous Agentic Delivery Platform

**Branch**: `feature/sisyphus-workflow-platform` | **Date**: 2026-08-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-sisyphus-workflow-platform/spec.md`

## Summary

Sisyphus runs Claude Code on isolated, per-run EC2 instances on behalf of Bluetel engineers, and makes those
runs **supervisable, resumable and auditable**. Six workspace projects deliver it: one shared contract package
owning the database and the entire typed API surface, one shared infrastructure package, one standalone
integration package per connector type (Jira only), and three deployables — a network-facing admin panel, a
non-network-facing control plane, and the executor that runs on the instance.

The technical approach rests on five decisions, all detailed in [research.md](./research.md):

1. **Corrections without restart** — drive the agent in headless streaming mode and inject additional user
   turns as NDJSON on stdin, keeping the process alive. `--resume` is the cold-start path only. The agent
   adapter sits behind one module boundary so the Agent SDK is a swap, not a rewrite (R1, spike S1).
2. **Resumability by pinning** — a fixed `/workspace` root with the agent's config tree relocated inside it,
   plus a platform-assigned session id, makes a snapshot a single tar that restores correctly on any instance
   (R2, spike S2).
3. **One suspend path** — pause, spot-interruption warning and stop-for-later are the same routine, so
   interruption handling is exercised on every manual pause (R3).
4. **One contract, three consumption modes** — the panel mounts the tRPC router, the control plane calls it
   in-process via `createCallerFactory`, and the executor imports only the router _type_ as a typed remote
   client. Access scoping lives in the request context, not in per-resolver conditionals (R4).
5. **Configuration over code** — setup bundles, workspaces, execution profiles and integrations make client
   onboarding a database row and an uploaded archive, not a deploy.

Delivery follows the spec's priority order, with US7 + US12 + US13 as one foundational slice.

## Technical Context

**Language/Version**: TypeScript 5.x, `strict` (inherited from `tsconfig.base.json`, must not be relaxed).
Node from `.nvmrc` (v24.15.0). ESM with `bundler` module resolution; extensionless imports.

**Typecheck gate — filtered, not relaxed (FR-198).** The three deployables and `sisyphus-infra` cannot
typecheck under plain `tsc --noEmit`, because SST's ambient `$config` / `sst.*` globals are only declared by
the generated `.sst/platform/config.d.ts`, and that tree is itself not `strict`-clean. Excluding it is not an
option: exclude it and the globals stop resolving, so the config files fail to compile. The target therefore
becomes `tsc --noEmit | loose-ts-check`, driven by two committed files per project — `ignored-error-codes.json`
and `loosely-type-checked-files.json`. Ignored codes apply **only within** the listed globs; everything else
stays strict. `.sst/**/*.ts` appears in three places and needs all three: `tsconfig.json` `include` (so the
globals resolve), the loose-glob list (so its errors don't fail the gate), and `eslint.config.mjs` `ignores`.
`sisyphus-infra`'s ignored set is narrow — the codes its own use of the ambient globals raises — where an app's
also covers the generated tree. `sisyphus-api` and `sisyphus-integration-jira` keep plain `tsc --noEmit` and
carry neither file, so neither gains a suppression channel it has no use for.

**Primary Dependencies**: tRPC v11 + Zod (contract), Drizzle ORM + `postgres` driver, Next.js 16 via OpenNext
on SST v3 (panel), Auth.js (Google OAuth), AWS SDK v3 (EC2/S3/SSM/Secrets Manager/EventBridge Scheduler),
`@slack/web-api`, shadcn-style primitives + Tailwind v3 + `cva` + `clsx`/`tailwind-merge`, `@google/design.md`
(pinned devDependency of the panel), Vitest, esbuild (executor bundle).

**Zod is pinned workspace-wide before any Sisyphus member is created.** Zod is currently declared per-member
(`^3.24.0`) with no `pnpm-workspace.yaml` override, while `@bluetel-ai/env-validation-errors` imports the
`zod/v3` and `zod-validation-error/v3` compatibility subpaths, which resolve only under Zod 4. Sisyphus makes Zod
cross-cutting across five new members, and a mixed graph produces "two Zods" inference failures inside tRPC's
`.input()` types that read as tRPC bugs. Resolving this — one major, pinned in `overrides` — is a prerequisite
task of the foundational slice, not a later cleanup.

**Configuration**: Every deployable reads environment through `createSafeEnv` from
`@bluetel-ai/env-validation-errors`, with an `env.ts` (explicit `runtimeEnv` map) and an `env-schemas.ts`
declaring server and client schemas separately. This is already lint-enforced workspace-wide — `eslint-config-base`
sets `@bluetel-ai/enforce-safe-env` to `error`, so reaching for `@t3-oss/env-core` directly fails lint. It also
means a missing bucket name or database URL fails at boot with a readable message naming the variable, rather
than surfacing as an `undefined` mid-bootstrap. The executor's `env` covers only instance-level values; every
job parameter and the scoped credential arrive in the user-data envelope instead.
`SISYPHUS_BOOTSTRAP_ADMIN_EMAILS` is part of this configuration and is what breaks the first-admin deadlock
(FR-174) — see [data-model.md](./data-model.md#users).

**Storage**: PostgreSQL on RDS — one instance per stage, schema and forward-only migrations owned by
`sisyphus-api`. S3 for logs, session snapshots, setup bundle archives and artifacts: private, encrypted,
partitioned per workflow, lifecycle-expired per object class. Parameter Store for deploy-time config; Secrets
Manager for runtime credentials.

**Testing**: Vitest, colocated `<name>.test.ts` beside every module — with one recorded exception. Contract
tests against the tRPC router via `createCallerFactory` with a seeded test database. Integration tests for the
executor's agent adapter against a stub agent process, so the loop is testable without paid inference.

The exception is `sisyphus-infra`'s resource-creating primitives (FR-200). Once a primitive instantiates
`sst.aws.*` / `aws.*` directly, unit-testing it means standing up a Pulumi mock harness to assert that the
construct we called is the construct we called — a test that restates the implementation and fails on every
rename. What is genuinely worth asserting is separated out and **is** tested: `getResourceIdentifier` and
`getPlainStage`, the retention schedule per object class, the content of each policy document (actions,
resources, conditions), and the trusted-subject string the CI identity provider will accept. A mistake in any
of those is a security or data-retention defect; a mistake in the wiring is a failed deploy, which the deploy
itself reports. See Complexity Tracking.

**Target Platform**: AWS. Panel as a serverless site behind CloudFront (OpenNext). Control plane as
non-network-facing Lambda functions invoked internally and by EventBridge Scheduler. Executor as a bundled
Node binary on Amazon Linux EC2, `x86_64`, instance type per execution profile.

**Project Type**: Nx monorepo — three deployable apps plus three shared packages, under the existing
`@bluetel-ai/*` scope.

**Performance Goals**: Agent output visible in the panel within 5s of production for ≥95% of output (SC-002).
Pause effective within 10s (SC-003). Workflow list responsive at tens of thousands of historical workflows
(FR-012, FR-013). Notification delivered within 2 minutes of the triggering state (SC-034).

**Constraints**: Control plane has **no** network-facing ingress (FR-035). Executor credentials are
workflow-scoped and machine-surface-only (FR-037). Nothing outside the requester's permitted scope may be
disclosed, including via counts and aggregates (FR-190). No instance outlives its workflow by more than 10
minutes (SC-007). Zero literal design values in components (SC-015). Setup bundle archives immutable once
registered (FR-090).

**Scale/Scope**: Tens of concurrent workflows, tens of thousands of historical workflows; single-tenant
internal platform, not multi-tenant SaaS. 192 functional requirements, 55 success criteria, 13 user stories.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

Evaluate each gate against `.specify/memory/constitution.md` (v1.0.0). Mark PASS, or FAIL with an
entry in Complexity Tracking below.

| Gate                             | Check                                                                                                                                                                     | Status                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| I. Nx-Orchestrated Workspace     | New projects land under `apps/`/`packages/`/`tooling/`, own their configs, and are run via `pnpm nx`                                                                      | PASS                         |
| II. Modular Code, Barrel Exports | Public API exposed through `index.ts`; no monolithic files; extensionless imports                                                                                         | PASS                         |
| III. Colocated Tests             | Every planned module has a colocated `<name>.test.ts` in the same directory                                                                                               | PASS with recorded exception |
| IV. Blocking Quality Gates       | Design passes lint, Prettier, `strict` typecheck, and `qlty:diff` (0 medium+ issues, ≤10% duplication) without threshold overrides                                        | PASS with recorded exception |
| V. Traceable, Spec-Driven Flow   | Work sits on `feature/<name>`; commits prefixed `BTAI-<n>: ` or `<branch>: `; this spec directory precedes implementation                                                 | PASS                         |
| Dependency Standards             | New deps added at the consuming workspace member; cross-cutting versions pinned in `pnpm-workspace.yaml` overrides; shared `tooling/` configs extended rather than forked | PASS                         |

**Notes on how each gate is met:**

- **I** — Six new members, all carrying the codename per FR-001: `packages/sisyphus-api`, `packages/sisyphus-infra`,
  `packages/sisyphus-integration-jira`, `apps/sisyphus-admin`, `apps/sisyphus-control-plane`,
  `apps/sisyphus-executor`. Each owns `project.json`, `eslint.config.mjs`, `tsconfig.json`, `vitest.config.ts`
  and is runnable from its own directory. A new cached `design-lint` target joins the affected-graph run
  alongside `lint`, `test` and `typecheck`.
- **II** — Every directory exposes an `index.ts` barrel; consumers import from the barrel. The largest risk is
  `sisyphus-api` becoming a monolith, so it is decomposed by domain (`db/`, `server/<domain>/`, `contracts/`,
  `schemas/`, `enums/`) with one file per concern and no god-module. One nuance worth stating: `sisyphus-api`
  exposes **four subpath barrels rather than one root barrel**, because a root barrel is what would let a panel
  client component import the database driver. The gate asks for a barrelled public API, not for exactly one —
  four barrels satisfy it and additionally make the FR-005 boundary a build-time fact.
- **III** — Colocated tests planned per module (FR-004). Three seams make this practicable without paid inference: the
  agent adapter (stub agent process), the AWS clients (interface + fake), and the connector contract (fake
  connector). Without these, US2/US3/US8 would only be testable end-to-end. **The one exception** is
  `sisyphus-infra`'s resource-creating primitives, which are deploy-verified rather than unit-tested; the pure
  logic they call is fully tested. Recorded in Complexity Tracking, per the constitution's Review clause.
- **IV** — `strict` inherited unchanged; no `QLTY_*` overrides. Duplication risk is concentrated in the three
  tRPC consumption modes and in per-entry workspace logic, both addressed by shared helpers rather than
  copy-paste. **The typecheck gate is filtered, not lowered**: `strict` stays on everywhere and no compiler
  option changes; the filter suppresses named error codes only inside committed globs that contain nothing but
  generated files. Recorded in Complexity Tracking because it is a suppression channel that did not previously
  exist, even though it lowers no threshold.
- **V** — Branch `feature/sisyphus-workflow-platform`; this directory carries `spec.md` → `plan.md` →
  `tasks.md` before implementation.
- **Dependency Standards** — Deps are added at the consuming member. Cross-cutting pins go in
  `pnpm-workspace.yaml` `overrides` (Tailwind is already pinned to v3 there, which is why the token layer uses
  CSS variables rather than v4 `@theme`). **Zod joins those overrides** — it becomes cross-cutting across all
  six members with this feature, and is currently unpinned and inconsistent with what
  `env-validation-errors` imports (see Technical Context). Lint/format/commit configs are extended from
  `tooling/`, never forked. `@google/design.md` is a pinned devDependency of the panel — never `npx`.
- **CI is extended, not replaced** — the constitution's _Development Workflow & Quality Gates_ section describes
  the pipeline that already exists in `.github/workflows/`: a `qlty` job against the PR base ref and a `main`
  job running `nx affected -t lint test typecheck`, with Node from `node-version-file`. Sisyphus adds
  `design-lint` to that affected run, the OIDC trust relationship, and a `trigger-deploy` + `deploy` target per
  deployable. Standing up a second CI provider was considered and rejected (research.md R12) — it would have
  put the two blocking gates in two systems and, in CircleCI's case, removed branch gating from the OIDC trust
  policy entirely. No constitution amendment is required as a result.

**Re-check after Phase 1 design**: PASS. No gate needed relaxing to accommodate the design.

**Re-check after the 2026-08-06 clarifications**: PASS, with gates III and IV each carrying one narrow,
bounded exception recorded in Complexity Tracking. Neither lowers a threshold — one narrows what is unit-tested
to what is worth asserting, the other filters generated code the gate was never meant to judge. The remaining
four gates are unchanged.

## Project Structure

### Documentation (this feature)

```text
specs/002-sisyphus-workflow-platform/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   ├── api-surface.md           # tRPC routers, procedures, authorisation
│   ├── executor-protocol.md     # Bootstrap phases, report-back, supervision
│   ├── setup-bundle.md          # Archive format and setup.sh contract
│   ├── integration-connector.md # The interface each integration package implements
│   └── design-tokens.md         # DESIGN.md front matter for the panel
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
packages/sisyphus-api/                     # The one shared contract — no root export (see below)
├── package.json                           # exports: ./server, ./client, ./contracts, ./db
├── src/
│   ├── db/                                # → ./db — migration tooling only
│   │   ├── schema/                        # Drizzle tables, one file per aggregate
│   │   ├── migrations/                    # Forward-only, versioned
│   │   ├── client.ts                      # Pooled connection factory
│   │   └── index.ts
│   ├── enums/                             # Workflow state, type, outcome, role, model allowlist
│   ├── schemas/                           # Zod input schemas — one source for resolvers and panel forms
│   ├── contracts/                         # → ./contracts — connector interface, executor protocol types
│   ├── server/                            # → ./server — never reachable from a browser bundle
│   │   ├── trpc.ts                        # createTRPCSetup: async context, procedures, middleware
│   │   ├── scope.ts                       # Memoised visible-profile resolution + scoped selectors (FR-190)
│   │   ├── workflow/                      # Lifecycle, supervision, queries
│   │   ├── machine/                       # Executor report-back surface (separate authorisation)
│   │   ├── admin/                         # Bundles, workspaces, profiles, integrations, users, grants
│   │   ├── root.ts                        # appRouter + createCaller
│   │   └── index.ts
│   └── client.ts                          # → ./client — AppRouter type, RouterInputs/Outputs, schemas, enums

packages/sisyphus-infra/                   # Shared, app-agnostic infrastructure primitives
├── package.json                           # exports: ".", "./scripts", "./*" — raw TS, no build step
├── ignored-error-codes.json               # Narrow: only what the ambient SST globals raise
├── loosely-type-checked-files.json
├── src/
│   ├── lib.ts                             # getResourceIdentifier, getEnvSecret          [pure, tested]
│   ├── get-plain-stage.ts                 # Stage-suffix stripping                       [pure, tested]
│   ├── retention.ts                       # Days + transition per object class           [pure, tested]
│   ├── policies.ts                        # Policy document content; trusted subject     [pure, tested]
│   ├── nextjs-website.ts                  # createNextjsWebsite(config)                  [deploy-verified]
│   ├── database.ts                        # createDatabase(config)                       [deploy-verified]
│   ├── buckets.ts                         # createBuckets(config)                        [deploy-verified]
│   ├── oidc-provider.ts                   # createOidcProvider(config) — async, looks up [deploy-verified]
│   ├── runner-role.ts                     # createRunnerRole(config)                     [deploy-verified]
│   ├── scheduler.ts                       # createScheduler(config)                      [deploy-verified]
│   └── scripts/                           # → ./scripts — Node runtime side, not Pulumi
│       ├── deploy-role-name.ts            # The one constant both the role and CI rebuild from
│       ├── ci-deploy-utils.ts             # OIDC token, assume-role, SSM → process.env / .env file
│       └── get-deployment-environment.ts

packages/sisyphus-integration-jira/        # One package per integration type (Jira only in scope)
├── src/
│   ├── discover.ts                        # JQL query for label-matched, in-scope tickets
│   ├── resolve-profile.ts                 # Ordered first-match mapping (FR-130)
│   ├── prompt-parts.ts                    # title, url, body, comments; excludes own comments (FR-161)
│   ├── write-back.ts                      # Pickup / skip / outcome comments, idempotent
│   ├── validate.ts                        # Connectivity check before enable
│   └── index.ts                           # Satisfies the connector contract

apps/sisyphus-admin/                       # Network-facing panel
├── DESIGN.md                              # Instrumentation design system (design-lint gated)
├── sst.config.ts                          # Application stack
├── sst-bootstrap.config.ts                # Per-stage prerequisites (params, OIDC, deploy role)
├── sst-install.config.ts                  # No-op; providers only, for type generation
├── ignored-error-codes.json
├── loosely-type-checked-files.json
├── src/
│   ├── app/
│   │   ├── layout.tsx                     # Root: providers + theme only
│   │   ├── page.tsx                       # `/` → redirect (authenticated: /workflows; else /sign-in)
│   │   ├── not-found.tsx                  # Styled, inside the shell (FR-197)
│   │   ├── error.tsx                      # Styled, inside the shell (FR-197)
│   │   ├── sign-in/page.tsx               # The one unauthenticated screen (FR-195)
│   │   ├── (app)/layout.tsx               # The application shell — sidebar + top bar (FR-193)
│   │   │   ├── workflows/                 # List, detail, live log, supervision controls
│   │   │   ├── settings/notifications/    # Per-event preferences + Slack identity (FR-138)
│   │   │   └── admin/                     # Bundles, workspaces, profiles, integrations, users
│   │   ├── api/trpc/[trpc]/route.ts       # Interactive surface
│   │   ├── api/machine/[trpc]/route.ts    # Machine surface (executor report-back)
│   │   ├── api/webhook/route.ts           # Signed external event ingress
│   │   └── api/auth/[...nextauth]/route.ts
│   ├── components/shell/                  # Sidebar, nav items, section marking, identity + sign-out
│   ├── components/ui/                     # shadcn-style primitives; state chip; log viewer
│   ├── lib/
│   │   ├── cn.ts                          # The one class-merge utility (FR-033)
│   │   └── sanitise/                      # Render-side guards
│   ├── trpc/                              # createTRPCReact + provider, RSC helpers, RouterInputs/Outputs
│   ├── env.ts                             # createSafeEnv — explicit runtimeEnv map
│   ├── env-schemas.ts                     # Server and client schemas, split by prefix
│   └── infrastructure/                    # bootstrap-env

apps/sisyphus-control-plane/               # Non-network-facing job runner
├── src/
│   ├── jobs/
│   │   ├── admit-workflow.ts              # Ceiling check, queue position (FR-040, FR-078)
│   │   ├── start-workflow.ts              # Provision, mint credential, bootstrap
│   │   ├── teardown-workflow.ts           # Verify durability, then release
│   │   ├── reconcile.ts                   # Both-directions leak sweep (FR-039)
│   │   ├── assemble-prompt.ts             # Preamble → intro → ticket, stored as sent (FR-159, FR-162)
│   │   ├── drain-queue.ts                 # Re-admit queued work when a lease releases (FR-040)
│   │   ├── validate-bundle.ts             # Validation-run job: no ticket, no workspace (FR-147)
│   │   ├── bootstrap-admins.ts            # Idempotent seed from configuration (FR-174)
│   │   ├── integration-tick.ts            # Discover → claim → start (FR-101)
│   │   └── sync-schedules.ts              # Register/re-register on change (FR-100)
│   ├── aws/                               # EC2, S3, SSM, Scheduler clients behind interfaces
│   ├── credentials/                       # Scoped JWT mint + renew (FR-037)
│   ├── notify/                            # Slack DM, preferences + watchers (FR-138, FR-141)
│   ├── api-caller.ts                      # In-process createCallerFactory (no network hop)
│   ├── env.ts                             # createSafeEnv — server-only schema
│   └── env-schemas.ts

apps/sisyphus-executor/                    # Runs on the instance
├── src/
│   ├── bootstrap/
│   │   ├── phases.ts                      # Named, individually-timed phases (FR-145, FR-146)
│   │   ├── bundle.ts                      # Download, verify digest, unpack, run setup.sh
│   │   └── workspace.ts                   # Per-entry checkout into pinned root (FR-112)
│   ├── agent/
│   │   ├── adapter.ts                     # start / send-turn / pause / snapshot / stop (R1 boundary)
│   │   ├── cli-stream.ts                  # NDJSON stdin implementation
│   │   └── frames.ts                      # Wire frames, parsed defensively
│   ├── session/
│   │   ├── snapshot.ts                    # Tar the pinned root; conversation + worktree (FR-050)
│   │   ├── restore.ts                     # Tolerates truncated trailing line (FR-053)
│   │   └── suspend.ts                     # The one pause/interrupt/stop path (FR-054)
│   ├── output/
│   │   ├── strip-control.ts               # ANSI, spinners, cursor movement (FR-045)
│   │   ├── redact.ts                      # Pattern + known-value (FR-045)
│   │   └── segments.ts                    # Sequenced, chunked, S3 + report-back
│   ├── skills/                            # Resolve sisyphus-dev/review/integration from primary entry
│   ├── report/                            # Machine-surface client (types-only import of AppRouter)
│   ├── interruption.ts                    # Reclamation watch → suspend()
│   ├── job-envelope.ts                    # Parse + validate user-data; the only source of job config
│   ├── env.ts                             # createSafeEnv — instance-level values only
│   └── env-schemas.ts
```

`sisyphus-control-plane` and `sisyphus-executor` carry the same five root files as the panel — the three
deployment configs and the two loose-check lists — omitted above only to keep their trees readable.

**How infrastructure is authored, and why it changed.** A primitive is a plain arrow function, `createX`,
taking one `config` object and returning a named object of the resources it created:
`createBuckets(config)` → `{ logs, snapshots, bundles, artifacts }`. Inside, it calls `new sst.aws.X(...)` or
`new aws.<service>.<Type>(...)` directly. It takes no provider, no constructor and no factory — providers are
configured once in the config file's `app()` and inherited implicitly. What **is** passed between primitives
is already-created resource handles, so `createNextjsWebsite({ buckets, database })` receives the objects
`createBuckets` and `createDatabase` returned, and derives `.arn` / `.name` itself. Where a resource needs an
identifier that only exists after a later resource is built, that wiring is its own exported `attachX`
function called at the end of `run()` rather than a circular argument.

The earlier design inverted this — every primitive declared a structural `*Provider` interface and received
constructors as arguments, so it could typecheck and unit-test without `sst install`. That constraint is
retired by FR-198 and FR-199: the install config generates the types with no credentials, and the loose-check
filter absorbs the generated tree. What the inversion cost was a layer of types that existed only to be
satisfied, and tests that asserted the fake had been called. Both go.

Naming is one helper, `getResourceIdentifier(name)` → `<project>-<stage>-<name>`, used as **both** the logical
id and the physical resource name so the two can never drift. Stage handling is one helper, `getPlainStage`,
stripping the known stack suffixes; the parameter-store path, the name prefix and every is-production test all
route through it, so a new stack type is one array entry rather than a grep. `DEPLOY_ROLE_NAME` is a
single-constant module because the bootstrap builds the role and the CI script rebuilds its identifier — two
literals that agree today are a silent breakage tomorrow.

**Why three config files per deployable.** They have genuinely different `app()` returns. The application
config resolves a dozen validated values before it can name the app; the bootstrap config must run when no
stack and no parameters exist yet, reading its own minimal schema straight from the parameter store over the
ambient credential chain; the install config must run on `pnpm install` in a fresh clone, where neither of the
other two could complete. Folding them into one `if` branch means every invocation evaluates preconditions
belonging to the other two. Every command that acts on a stack — deploy, destroy, unlock — names its config
explicitly; a `destroy` that omits it loads the wrong stack's configuration and mis-plans the teardown. The
install config's providers must be pinned to exactly the versions the application config declares, or the
generated types describe something a deploy will not resolve.

Configuration is read inside `app()` / `run()`, never at module scope, and every import in a config file is a
dynamic `await import()` for the same reason: SST's ambient globals do not exist at module-evaluation time,
and `createSafeEnv` snapshots `SKIP_ENV_VALIDATION` when its module is first evaluated. A static import would
read that flag before the config had a chance to set the stage. Secrets are Pulumi-wrapped so they cannot land
in state in plain text, with one named exception — a token the provider itself needs in order to be
constructed cannot be an unresolved output, and that call site says so.

**How the panel reaches the control plane.** FR-035 gives the control plane no inbound network surface, yet the
panel's `start` mutation has to cause provisioning. The panel therefore **never invokes it**: `start` writes a
`queued` workflow and returns. The control plane's admission job is triggered by the same EventBridge Scheduler
that drives integration ticks, plus a Postgres `NOTIFY` on insert to keep latency low — so the edge is a database
write the control plane polls, not an endpoint. Nothing in the panel holds permission to provision, which is what
makes FR-035 structural rather than a matter of nobody having added a route yet. `drain-queue.ts` and
`bootstrap-admins.ts` run on the same trigger.

**The shell is a route group, not a component.** `(app)/layout.tsx` wraps every authenticated screen, so a new
screen is inside the shell by existing rather than by remembering to import it — which is precisely how twelve
screens ended up reachable only by URL. `sign-in` sits outside that group because it is the one screen a
signed-out visitor may render. The sidebar's admin section is filtered by the session role rather than hidden
by CSS: a link an engineer cannot follow is not rendered, so the nav never advertises a surface that will
answer `NOT_FOUND` (FR-190). `not-found.tsx` and `error.tsx` sit at the root so they also catch the
`notFound()` that `requireAdminPage()` throws, which today lands on the framework's unstyled default.

**Structure Decision**: Six workspace members as above. `sisyphus-api` is the only member that touches the
database, which is what makes FR-005's surface split and FR-190's scoping enforceable in one place rather than
audited across three apps. The executor depends on `sisyphus-api` for **types only** — no resolver code and no
database driver reaches the instance, so a compromised setup bundle cannot read the database.

`sisyphus-api` declares **no root `.` export**; each consumption mode gets its own subpath, so that boundary is a
build-time fact rather than a review convention. A single root barrel would put `postgres`, Drizzle and every
resolver one import away from a panel client component, and the executor's types-only guarantee — which FR-005
relies on — would rest on nobody making a mistake. Each subpath directory keeps its own `index.ts`, so
constitution gate II is satisfied; what is removed is only the root barrel that would collapse the four. Each integration
type is a standalone package (FR-192) depending on the connector contract in `sisyphus-api`; the control plane
depends on the contract, never on Jira. `sisyphus-infra` is consumed by the deployables' `sst.config.ts` and
never at runtime.

## Phase Sequencing

The spec's delivery order, mapped to what each slice must land with. Two spikes (research.md S1, S2) gate the
supervision slices and run first.

| Order | Slice               | Lands with                                                                                                                                                                                                                                                                                                                                                          |
| ----- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Spikes S1 + S2 + S3 | NDJSON frame shape confirmed or SDK fallback adopted; cross-instance restore proven; live-log transport proven under pooling (S3)                                                                                                                                                                                                                                   |
| 1     | US7 + US12 + US13   | Zod pinned in `overrides`; `env.ts` + `env-schemas.ts` per deployable; contract package with its four subpath exports, schema, auth, roles, profile-scoped access, bundle registration + validation runs. **These ship together** — registration without its gate means any user can install client credentials, and an unscoped workflow list leaks across clients |
| 2     | US1                 | Provisioning, bootstrap phases, executor, sanitised streaming, draft PR, teardown, reconciliation                                                                                                                                                                                                                                                                   |
| 3     | US9                 | Workspaces + execution profiles, profile-first launch form, per-run overrides                                                                                                                                                                                                                                                                                       |
| 4     | US11                | Ownership, Slack DM notifications, ticket write-back                                                                                                                                                                                                                                                                                                                |
| 5     | US2                 | Pause, correction injection, resume — depends on S1                                                                                                                                                                                                                                                                                                                 |
| 6     | US3                 | Snapshot/restore across instances, successor workflows — depends on S2                                                                                                                                                                                                                                                                                              |
| 7     | US10                | Multi-entry workspaces, PR sets, per-entry results                                                                                                                                                                                                                                                                                                                  |
| 8     | US8                 | Jira integration package, scheduling, claiming, prompt assembly                                                                                                                                                                                                                                                                                                     |
| 9     | US4                 | Autonomous loop, skill resolution, iteration bounding                                                                                                                                                                                                                                                                                                               |
| 10    | US5                 | Standalone review workflow                                                                                                                                                                                                                                                                                                                                          |
| 11    | US6                 | Fleet oversight, filtering, cost aggregation                                                                                                                                                                                                                                                                                                                        |

**Remediation slices added 2026-08-06.** These follow the built work rather than re-ordering it, but none is
optional and one closes a live defect.

| Order | Slice                                                    | Lands with                                                                                                                                                                                                                                                                       |
| ----- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12    | Shell & entry (FR-193..FR-197, FR-201)                   | Sign-in screen **first** — the auth layer already points at a route that 404s, so this is a break, not a gap. Then the `(app)` shell with role-filtered sidebar, identity and sign-out; `/` redirect; root not-found and error boundaries; per-screen loading/empty/error states |
| 13    | Notification settings (FR-138)                           | `/settings/notifications` over the preferences already built behind `workflow/watch.ts`, plus the Watch/Unwatch control on workflow detail                                                                                                                                       |
| 14    | Infrastructure re-shape (FR-066, FR-198..FR-200, FR-202) | `sisyphus-infra` primitives rewritten to direct constructs with the pure layer extracted and kept under test; three config files per deployable; filtered typecheck target with its two lists per project                                                                        |

Slice 12 before 13: the settings screen has nowhere to be reached from until the shell exists. Slice 14 is
independent of both and can run in parallel — it touches no application code.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No threshold is relaxed, no shared config forked, no Nx graph bypassed. **Two gates now carry a recorded
exception**, added 2026-08-06. Both are narrow, both are visible in a diff, and both are recorded here rather
than argued per-review, which is what the constitution's Review clause asks for.

| Gate                       | Exception                                                                                                                     | Bound                                                                                                                                                                                                                   | Alternative rejected because                                                                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| III. Colocated Tests       | `sisyphus-infra`'s six resource-creating primitives ship without a colocated `.test.ts`; they are verified by the deploy      | Only functions whose body is resource instantiation. Every pure decision they consume — naming, stage derivation, retention per class, policy document content, the CI trusted subject — stays a tested module (FR-200) | A Pulumi mock harness asserts that the constructor we called is the constructor we called: it restates the implementation, breaks on rename, and would not have caught a single real infrastructure defect |
| IV. Blocking Quality Gates | The typecheck target for the three deployables and `sisyphus-infra` filters named error codes inside committed globs (FR-198) | `strict` unchanged, no compiler option touched, no inline suppression comment. Globs contain only generated files. Both lists are committed, so widening them is a reviewable diff                                      | Excluding the generated tree from `include` makes the deployment tool's ambient globals unresolvable, so the config files stop compiling — the gate would pass by no longer checking the code that matters |

Two further design choices are worth recording as deliberate, though neither breaches a gate:

| Choice                                               | Why                                                                                                                                          | Simpler alternative rejected because                                                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Six workspace members rather than four               | FR-035's no-ingress control plane and FR-192's per-type integration packages are both structural requirements, not organisational preference | Merging the control plane into the panel would give the network-facing app the provisioning role, which is the boundary FR-035 exists to draw |
| Access scoping in the tRPC context, not per resolver | FR-190 forbids disclosing a workflow's _existence_, so counts and aggregates must be scoped too                                              | Per-resolver checks leak through any aggregate someone forgets to guard, and the failure is silent                                            |
