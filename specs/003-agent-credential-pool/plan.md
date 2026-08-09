# Implementation Plan: Agent Credential Pool

**Branch**: `feature/sisyphus` | **Date**: 2026-08-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-agent-credential-pool/spec.md`

## Summary

Move the agent's credential out of the setup bundle and into a pooled, leased entity, because a subscription
login rotates its own refresh credential and a bundle-carried copy is stale the moment the agent uses it. One
workflow holds exactly one credential from admission to terminal state; rotations are written through to a
secret store as they happen; a fencing value stops a partitioned instance overwriting newer material. Pause
becomes an instance **stop** with disk retained rather than a process held alive, so resume is a start.

The work extends four existing projects and creates none. No new dependencies: every AWS client this needs
(`client-ec2`, `client-secrets-manager`, `client-ssm`) is already a dependency of `apps/sisyphus-control-plane`.

**The two riskiest unknowns are provider behaviours, not design choices** — how a rotated refresh credential
invalidates its predecessor, and how long one survives disuse. Both are resolved in Phase 0 by experiment, and
both are contained behind a single seam so a wrong guess costs one module.

## Technical Context

**Language/Version**: TypeScript ~5.9.2, Node 24.15.0 (`.nvmrc`), ESM, `strict` + `isolatedModules` +
`bundler` resolution from `tsconfig.base.json`

**Primary Dependencies**: drizzle-orm 0.45, @trpc/server 11.18, zod 3.25, postgres 3.4, jose 6 —
all already present. AWS: `@aws-sdk/client-ec2`, `@aws-sdk/client-secrets-manager`, `@aws-sdk/client-ssm`,
already dependencies of the control plane. **No new dependencies at any workspace member.**

**Storage**: PostgreSQL owned exclusively by `packages/sisyphus-api` (drizzle schema + migrations). Credential
material in AWS Secrets Manager, never in Postgres. Payload/snapshot objects remain in S3.

**Testing**: Vitest 4, colocated `<name>.test.ts`, run via `pnpm nx`. Existing fake-provider pattern
(`compute-fake.ts`, `secrets-fake.ts`, `object-store-fake.ts`) extended rather than replaced, so every new path
is testable without an AWS account.

**Target Platform**: AWS — control plane and admin panel deployed via SST; executor runs on EC2 instances.

**Project Type**: pnpm/Nx monorepo. Four existing members change; none is added.

**Performance Goals**: a released credential reaches a waiting workflow within 30s (SC-005); resume from pause
reaches first agent turn ≥5× faster than a cold start (SC-007).

**Constraints**: exactly one live holder per credential, enforced against partition and race (SC-003, FR-020);
zero credential material in logs, snapshots, envelopes, bundles or admin-visible surfaces (SC-014).

**Scale/Scope**: tens of credentials across a handful of groups; concurrency bounded by pool size. Deliberately
small — the pool is a scarce resource by construction, not a horizontally scaled one.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

Evaluate each gate against `.specify/memory/constitution.md` (v1.0.0). Mark PASS, or FAIL with an
entry in Complexity Tracking below.

| Gate                             | Check                                                                                                                                                                     | Status                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| I. Nx-Orchestrated Workspace     | New projects land under `apps/`/`packages/`/`tooling/`, own their configs, and are run via `pnpm nx`                                                                      | **PASS** — no new projects    |
| II. Modular Code, Barrel Exports | Public API exposed through `index.ts`; no monolithic files; extensionless imports                                                                                         | **PASS** — see note below     |
| III. Colocated Tests             | Every planned module has a colocated `<name>.test.ts` in the same directory                                                                                               | **PASS**                      |
| IV. Blocking Quality Gates       | Design passes lint, Prettier, `strict` typecheck, and `qlty:diff` (0 medium+ issues, ≤10% duplication) without threshold overrides                                        | **PASS**                      |
| V. Traceable, Spec-Driven Flow   | Work sits on `feature/<name>`; commits prefixed `BTAI-<n>: ` or `<branch>: `; this spec directory precedes implementation                                                 | **PASS** — `feature/sisyphus` |
| Dependency Standards             | New deps added at the consuming workspace member; cross-cutting versions pinned in `pnpm-workspace.yaml` overrides; shared `tooling/` configs extended rather than forked | **PASS** — zero new deps      |

**Gate II note.** Credential allocation is the one place where a monolith is a real temptation: selection,
queueing, fencing and health all touch the same rows. The design splits it into `allocate/`, `lease/`,
`liveness/` and `health/` under `apps/sisyphus-control-plane/src/credentials/`, each with a single
responsibility and its own barrel, rather than one `credential-pool.ts`. Re-checked after Phase 1 — still PASS.

**Post-Phase 1 re-check**: PASS on all six. No violations, so Complexity Tracking is omitted.

## Project Structure

### Documentation (this feature)

```text
specs/003-agent-credential-pool/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── credential-lifecycle.md
│   ├── allocation-protocol.md
│   └── executor-credential.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/sisyphus-api/src/
├── enums/
│   ├── credential-state.ts          # awaiting_login | available | held | cooling_off | unhealthy | disabled
│   ├── credential-release-reason.ts # terminal | forced | login_replaced
│   ├── bootstrap-phase.ts           # + credential_install (ordered; migration — see research R7)
│   └── workflow-state.ts            # + awaiting_credential
├── db/schema/
│   ├── credential.ts                # agentCredentials, credentialGroups, credentialLeases,
│   │                                #   profileCredentialGroups, keepAliveRuns
│   └── profile.ts                   # unchanged; attachment lives on its own table
├── db/migrations/                   # generated
├── contracts/                       # zod shapes shared by panel, control plane and executor
└── server/
    ├── admin/
    │   ├── credential-store.ts      # reads/writes, no transport
    │   ├── credentials.ts           # tRPC: register, re-login, disable, force-release
    │   ├── credential-groups.ts     # tRPC: create, rename, membership, attach to profile
    │   └── credential-pool.ts       # tRPC: the FR-053/FR-054 pool + queue view
    └── machine/
        └── agent-credential.ts      # tRPC: fetchLeased, reportRotation (scoped-credential guarded)

apps/sisyphus-control-plane/src/
├── aws/
│   ├── compute.ts                   # + stop/start/describeVolumes (currently terminate-only)
│   └── secrets.ts                   # + write/rotate (currently SecretReader only)
├── credentials/
│   ├── allocate/                    # group-ordered selection + LRU within group
│   ├── lease/                       # acquire, release, fence, reconcile
│   ├── liveness/                    # keep-alive schedule
│   ├── health/                      # cooling-off vs unhealthy classification
│   └── login/                       # ephemeral login environment + relay
└── jobs/
    ├── admit-workflow.ts            # + credential reservation gate (before provisioning)
    ├── drain-queue.ts               # + grant released credential to longest reachable waiter
    ├── reconcile.ts                 # + stranded-lease sweep
    └── pause-instance.ts            # stop-with-disk, replacing hold-alive

apps/sisyphus-executor/src/
├── bootstrap/
│   └── credential-install.ts        # fetch leased material, install, report phase
├── credential/
│   └── rotation-watch.ts            # detect + write through rotations
└── session/
    └── suspend.ts                   # stop path rather than hold-alive

apps/sisyphus-admin/src/app/(app)/admin/
└── credentials/                     # pool view, group management, login flow
```

**Structure Decision**: Extend the four existing Sisyphus members; create no new project. The feature is a new
concern _inside_ an existing platform, not a new deployable — a fifth project would need its own configs,
targets and CI wiring while sharing the same database that `packages/sisyphus-api` owns exclusively, which
would breach that ownership rule for no benefit. Credential allocation lives in the control plane because it is
a scheduling decision made before compute exists; the API package owns only schema, contracts and transport,
consistent with how bundles and profiles are already split.

## Complexity Tracking

> No Constitution Check violations. Section intentionally empty.
