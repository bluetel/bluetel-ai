# Implementation Plan: Remove the repository-reachability half of the profile enable gate

**Branch**: `feature/sisyphus` | **Date**: 2026-08-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-remove-reachability-gate/spec.md`

## Summary

Delete the `RepositoryReachabilityProbe` seam and every reference to it, so `admin.profiles.setEnabled(true)`
stops making an outbound check it can never satisfy and starts succeeding for correctly configured profiles.
The five local checks FR-124 still mandates — published version, readable pinned rows, bundle enabled and
unarchived, workspace unarchived, workspace non-empty — are kept exactly as they are.

The technical approach is **subtraction, not substitution**. Nothing replaces the probe: no platform
credential, no deferred check, no feature flag, no always-reachable stub left in place "for later". A stub left
behind is what produced this defect, and leaving a disabled one would preserve the same trap. `checkProfileCanBeEnabled`
loses its second parameter and becomes synchronous and pure; `createProfilesRouter` loses its only injectable
and collapses into the plain `profilesRouter` the barrel already exports.

Net effect is a deletion of roughly 450 lines across two workspace members, with **no database migration**, no
new dependency, and no change to any wire schema other than the disappearance of one refusal category.

## Technical Context

**Language/Version**: TypeScript 5.x, `strict`, inherited from `tsconfig.base.json` — not relaxed by this work.

**Primary Dependencies**: tRPC (router and `TRPCError`), Drizzle (the retained checks' reads), Zod (unchanged
inputs), Vitest (colocated suites), Next.js App Router (the panel that renders the refusal). No dependency is
added or removed.

**Storage**: PostgreSQL. **No migration.** `execution_profiles.enabled` already exists and keeps its meaning;
only the predicate guarding writes to it narrows. No column, index, or constraint changes.

**Testing**: Vitest, colocated per Principle III. `packages/sisyphus-api`'s profile suites are database-backed
and skip rather than fail without `DATABASE_URL`, so the retained-check assertions must be run with a database
to count — see [quickstart.md](./quickstart.md).

**Target Platform**: The panel (Next.js on AWS Lambda) mounts `admin.profiles`; `packages/sisyphus-api` is the
shared library. Nothing in the executor or control plane changes behaviour — only two stale doc comments.

**Project Type**: Nx + pnpm monorepo. This change touches two existing workspace members and creates no new
project.

**Performance Goals**: `setEnabled(true)` becomes wholly local — its duration is independent of the number of
workspace entries and of network conditions (SC-002). Today the refusing probe already answers without I/O, so
this is about removing the _capability_ for an outbound call, not about reclaiming latency.

**Constraints**: `qlty:diff` must pass with no threshold override; `pnpm knip:orphans` must stay green, which
requires deleting the `reachability-fake.ts` production-only exclusion from `knip.json` in the same change as
the file (Principle: config and docs are corrected alongside the code they describe).

**Scale/Scope**: 4 files deleted, 12 modified, ~450 net lines removed. Two of the modified files are outside
`packages/sisyphus-api` and are doc-comment-only edits.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

Evaluate each gate against `.specify/memory/constitution.md` (v1.0.0). Mark PASS, or FAIL with an
entry in Complexity Tracking below.

| Gate                             | Check                                                                                                                                                                     | Status |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| I. Nx-Orchestrated Workspace     | New projects land under `apps/`/`packages/`/`tooling/`, own their configs, and are run via `pnpm nx`                                                                      | PASS   |
| II. Modular Code, Barrel Exports | Public API exposed through `index.ts`; no monolithic files; extensionless imports                                                                                         | PASS   |
| III. Colocated Tests             | Every planned module has a colocated `<name>.test.ts` in the same directory                                                                                               | PASS   |
| IV. Blocking Quality Gates       | Design passes lint, Prettier, `strict` typecheck, and `qlty:diff` (0 medium+ issues, ≤10% duplication) without threshold overrides                                        | PASS   |
| V. Traceable, Spec-Driven Flow   | Work sits on `feature/<name>`; commits prefixed `BTAI-<n>: ` or `<branch>: `; this spec directory precedes implementation                                                 | PASS   |
| Dependency Standards             | New deps added at the consuming workspace member; cross-cutting versions pinned in `pnpm-workspace.yaml` overrides; shared `tooling/` configs extended rather than forked | PASS   |

**Notes on the gates that required a judgement rather than an observation:**

- **II (barrels).** Four exports leave `server/admin/index.ts` (`createRefusingReachabilityProbe`,
  `probeTargets`, `RepositoryReachabilityProbe`, `ProfilesRouterOptions`) and one more (`createProfilesRouter`)
  goes with the collapse. Removing an export from a barrel is a public-surface change to
  `@bluetel-ai/sisyphus-api/server`; no consumer outside this repository exists, and the only in-repo consumer
  is a test that is being rewritten in the same change.
- **III (colocated tests).** Two module/test pairs are deleted **together** — never a module leaving its test
  behind, which would leave an orphan suite, nor a test leaving its module untested. Every surviving module
  keeps its colocated suite, and `profile-gate.test.ts` gains coverage rather than losing it: the six retained
  refusals each get an assertion that currently rides on a combined reachability case.
- **IV (`qlty:diff`).** A change that is mostly deletion cannot raise the duplication ratio, and removes rather
  than adds lint surface. No override is used.
- **V (branch).** Work continues on `feature/sisyphus`, which matches `feature/<name>`. This spec directory was
  written before any implementation edit, and the two exploratory edits begun before the spec existed were
  abandoned rather than kept.

## Project Structure

### Documentation (this feature)

```text
specs/004-remove-reachability-gate/
├── plan.md              # This file (/speckit-plan command output)
├── spec.md              # Feature specification
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   └── profile-enable.md
├── checklists/
│   └── requirements.md  # Spec quality checklist (/speckit-specify output)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
packages/sisyphus-api/
├── src/server/
│   ├── context.ts                          # M  drop `repositoryReachability` from SisyphusDependencies
│   ├── admin/
│   │   ├── reachability.ts                 # D  the seam, the refusing default, probeTargets
│   │   ├── reachability.test.ts            # D
│   │   ├── reachability-fake.ts            # D  the recording fake
│   │   ├── reachability-fake.test.ts       # D
│   │   ├── profile-gate.ts                 # M  drop the probe param + probing loop; sync; -1 element
│   │   ├── profile-gate.test.ts            # M  rewrite around the six retained refusals
│   │   ├── profiles.ts                     # M  collapse createProfilesRouter → profilesRouter
│   │   ├── profiles.test.ts                # M  build the caller from profilesRouter
│   │   ├── index.ts                        # M  drop 5 exports
│   │   └── workspace-entries.ts            # –  unchanged: describeWorkspaceEntry has other callers
│   ├── notify/emitter.ts                   # M  doc comment only — cites the refusing probe as precedent
│   └── workflow/launch-configuration.test.ts # M  import profilesRouter instead of the factory
│
apps/sisyphus-admin/
└── src/components/admin/profiles/
    ├── enable-refusal.ts                   # M  drop workspace_entry element, code and action
    ├── enable-refusal.test.ts              # M  drop the entry-line cases, keep the unclassified fallback
    └── profile-card.test.tsx               # M  restate one fixture on a retained element

apps/sisyphus-control-plane/
└── src/jobs/prompt-redact.ts               # M  doc comment only — same stale precedent

knip.json                                   # M  drop the reachability-fake production-only exclusion
```

**Structure Decision**: No new directories and no new project. The change is confined to the
`server/admin/` directory of `packages/sisyphus-api` (where the gate lives), one component directory of
`apps/sisyphus-admin` (where its refusal is rendered), and three peripheral files carrying stale references —
two doc comments and one dead-code-config entry. `workspace-entries.ts` is deliberately untouched:
`describeWorkspaceEntry` loses its `profile-gate.ts` caller but retains three inside its own module, so it is
not orphaned by this work.

## Constitution Re-Check (post-Phase 1)

Re-evaluated after `research.md`, `data-model.md`, `contracts/profile-enable.md` and `quickstart.md` were
written. **All six gates still PASS.** The design surfaced three things worth recording:

1. **III (colocated tests) got stronger, not weaker.** R9 found that several retained behaviours — multi-failure
   collection in particular — are today asserted only as the incidental passing half of a reachability test.
   Deleting those cases without restating what they covered would have quietly reduced coverage of exactly the
   checks US2 exists to protect. `profile-gate.test.ts` is therefore rewritten around one known failure per
   retained refusal rather than trimmed.
2. **IV (quality gates) has a real trap, and it is not lint.** `packages/sisyphus-api`'s profile suites skip
   rather than fail without `DATABASE_URL`. A green `pnpm nx affected -t test` proves nothing about this
   feature unless a database is present — the same defect `specs/002`'s plan records as having hidden a third
   of this package's assertions. `quickstart.md` opens with a skip-count check for that reason.
3. **Configuration is in scope (R8).** `knip.json` names `reachability-fake.ts`. The constitution requires a
   tool's configuration and the code to be corrected in the same change, so the exclusion is deleted with the
   file rather than left as harmless-but-false config.

No gate required a justification, so Complexity Tracking stays empty.

## Complexity Tracking

> No Constitution Check violations, before or after design. This section is intentionally empty — the change
> removes a seam rather than adding one, and introduces no abstraction requiring justification.
