# Phase 1 Data Model: Remove the repository-reachability half of the profile enable gate

> **DEPRECATED (2026-08-11):** The Sisyphus workflow platform — including the executor, control plane, admin app, and agent credential pool described in this document — has been deprecated in favour of the Claude Code GitHub Action. This was because the GitHub Action is easier to maintain and configure, and more customizable than the bespoke infrastructure it replaced. This document is retained as a historical design record only; the packages and apps it describes have been removed from the repository.

**Feature**: `specs/004-remove-reachability-gate` | **Date**: 2026-08-09

## Database: no change

**No migration is required or permitted by this feature.** No table, column, index, constraint, enum or
default is added, altered or dropped.

The one persisted field the feature concerns is `execution_profiles.enabled`, and it changes neither type nor
meaning — only the predicate guarding writes to it narrows. `specs/002-.../data-model.md` has been amended to
restate that predicate.

| Table                | Field     | Change                                                                      |
| -------------------- | --------- | --------------------------------------------------------------------------- |
| `execution_profiles` | `enabled` | **None.** Still boolean, still gated by FR-124, gate now checks five things |

There is no stored reachability verdict anywhere in the schema — the probe was called live during
`setEnabled` and its result was never persisted — so there is no data to migrate, backfill or discard.

## Type model: what changes

The feature's real model is at the type level, in two closed sets and three signatures.

### `ProfileEnableElement` — loses one member

`packages/sisyphus-api/src/server/admin/profile-gate.ts`

| Member              | Fate        | Meaning                                                         |
| ------------------- | ----------- | --------------------------------------------------------------- |
| `profile_version`   | Kept        | No published version, or its pinned rows could not be read      |
| `setup_bundle`      | Kept        | The pinned bundle is disabled, or archived                      |
| `workspace_version` | Kept        | The workspace is archived, or the version holds no entries      |
| `workspace_entry`   | **Removed** | One entry's repository could not be reached — no longer emitted |

The set is closed (`as const`, indexed into an exhaustive `Record` on the panel side), so removing the member
is a compile-checked change: any surviving reference fails `strict` typecheck rather than lingering.

### `ProfileEnableFailure` / `ProfileEnableCheck` — unchanged in shape

Both keep their fields exactly (`element` + `detail`; `passed` + `failures`). Only the domain of `element`
narrows. `passed` remains derived from `failures.length === 0` through the same private `verdict` helper, so
the two can still never disagree.

### Deleted types

All from `packages/sisyphus-api/src/server/admin/reachability.ts` and `reachability-fake.ts`:

| Type / value                         | Notes                                               |
| ------------------------------------ | --------------------------------------------------- |
| `ReachabilityTarget`                 | `{ repositoryUrl, baseBranch }`                     |
| `ReachabilityOutcome`                | The reachable / not-reachable-with-reason union     |
| `RepositoryReachabilityProbe`        | The one-method seam                                 |
| `ReachabilityReport`                 | Target paired with verdict                          |
| `REACHABILITY_NOT_CONFIGURED_REASON` | The string in the error users are hitting today     |
| `createRefusingReachabilityProbe`    | The refuse-everything default                       |
| `probeTargets`                       | The probe-all-and-collect helper                    |
| `FakeReachabilityProbe`              | Recording fake                                      |
| `createFakeReachabilityProbe`        | Its constructor                                     |
| `ProfilesRouterOptions`              | From `profiles.ts`; existed only to carry the probe |

### Changed signatures

| Function                    | Before                                                    | After                                     |
| --------------------------- | --------------------------------------------------------- | ----------------------------------------- |
| `checkProfileCanBeEnabled`  | `(subject, probe) => Promise<ProfileEnableCheck>`         | `(subject) => ProfileEnableCheck`         |
| `runEnableGate` _(private)_ | `(writer, profile, probe) => Promise<ProfileEnableCheck>` | `(writer, profile) => Promise<…>`         |
| `createProfilesRouter`      | `(options: ProfilesRouterOptions) => Router`              | **Deleted** — `profilesRouter` is the API |

`runEnableGate` stays `async`: it still awaits two database reads. Only its final expression stops being
awaited.

### `SisyphusDependencies` — loses one optional field

`packages/sisyphus-api/src/server/context.ts` drops `repositoryReachability?: RepositoryReachabilityProbe`.
Every host already omits it, so no host implementation changes. The `notifier` field's doc comment, which
explains itself by contrast with this one, is rewritten.

## Panel type model

`apps/sisyphus-admin/src/components/admin/profiles/enable-refusal.ts`

`ENABLE_FAILURE_ELEMENTS` mirrors the server's closed set plus `unclassified`. It loses `workspace_entry`,
which removes:

- one member of `EnableFailureElement`,
- one entry from the exhaustive `ACTIONS` record,
- one branch from `classifyEnableFailure`,
- and, by consequence, the derivable code `E_PROFILE_ENABLE_WORKSPACE_ENTRY`.

`enableFailureCode` is unchanged — it derives the code from the element, so the vanishing code needs no edit.

`unclassified` is **retained and load-bearing**: it is what lets the panel render a refusal line whose wording
it does not recognise, which is what keeps FR-010 satisfied for any future server wording.

## Invariants preserved

1. `passed === (failures.length === 0)` — enforced by construction, unchanged.
2. Every failure names its element and carries a sentence an admin can act on.
3. All failures are reported together; the gate never stops at the first.
4. A refused enable writes nothing — the gate runs inside the same transaction as the update and throws
   before it.
5. `setEnabled(false)` never runs the gate.
