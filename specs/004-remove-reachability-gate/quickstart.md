# Quickstart Validation: Remove the repository-reachability half of the profile enable gate

**Feature**: `specs/004-remove-reachability-gate` | **Date**: 2026-08-09

How to prove this feature works. Scenario 1 is the whole point; 2 guards what must not be lost; 3–5 are the
gates that make the claim credible.

## Prerequisites

```bash
pnpm install --frozen-lockfile
```

**A database is required for the enable suites to mean anything.** `packages/sisyphus-api`'s profile tests are
database-backed and **skip rather than fail** without `DATABASE_URL` — a green run without one proves nothing
about this feature. This is the exact trap recorded in `specs/002`'s plan ("CI ran no Postgres, so a third of
`sisyphus-api`'s assertions never executed while the pipeline reported green").

```bash
export DATABASE_URL='postgres://…'
pnpm nx run sisyphus-api:migrate
```

Confirm the suites are actually running before trusting any result below:

```bash
pnpm nx test sisyphus-api -- profiles --reporter=verbose | grep -ci skipped
```

## Scenario 1 — A profile can be enabled at all (SC-001, US1)

The regression this feature exists to fix.

```bash
pnpm nx test sisyphus-api -- profile-gate profiles
```

**Expect:**

1. A profile pinning an enabled bundle and a workspace with ≥1 entry **enables**, and the enable is recorded in
   the configuration audit trail against the version it validated.
2. A profile whose workspace names a repository that does not exist **also enables** — the platform makes no
   attempt to verify it.
3. Enabling an already-enabled profile succeeds and records no second audit entry.
4. No test anywhere constructs a reachability probe, because none exists.

**Manual confirmation** (the failure users actually reported):

```bash
pnpm nx dev sisyphus-admin
```

Sign in as an admin, open **Admin → Profiles**, enable a profile with several repositories. It turns on. The
`E_PROFILE_ENABLE_WORKSPACE_ENTRY` refusal — one line per repository — does not appear.

## Scenario 2 — The retained checks still bite (SC-003, US2)

Removing the unimplementable check must not weaken the implementable ones. Each is proven by a **known
failure**, not by observing a pass.

```bash
pnpm nx test sisyphus-api -- profile-gate
```

**Expect a refusal naming the failing element for each of:**

| Case                                          | Element             |
| --------------------------------------------- | ------------------- |
| No published version                          | `profile_version`   |
| Pinned rows unreadable                        | `profile_version`   |
| Bundle disabled                               | `setup_bundle`      |
| Bundle archived (and **not** also "disabled") | `setup_bundle`      |
| Workspace archived                            | `workspace_version` |
| Workspace version holds no entries            | `workspace_version` |

Plus: a profile failing two conditions reports **both** in one refusal, and every refusal leaves the profile
unchanged.

Then confirm the escape hatch stays open:

```bash
pnpm nx test sisyphus-api -- profiles
```

`setEnabled(false)` succeeds on a profile that could not currently be enabled.

## Scenario 3 — The panel renders what remains (FR-010)

```bash
pnpm nx test sisyphus-admin -- enable-refusal profile-card
```

**Expect:**

1. `ENABLE_FAILURE_ELEMENTS` no longer contains `workspace_entry`, and `ACTIONS` has no entry for it.
2. A multi-line refusal still becomes one notice per line, each with a code and a next action.
3. **A line the classifier does not recognise still renders** as `unclassified` with its verbatim text — the
   fallback that makes FR-010 hold for any future wording. Assert this with a line matching no known phrasing.

## Scenario 4 — Nothing dead is left behind (SC-005, Constitution IV)

The gates that would catch a half-finished removal.

```bash
pnpm typecheck
pnpm lint:check
pnpm knip
pnpm knip:orphans
```

(`pnpm lint:check` rather than `pnpm lint` — the latter runs `--configuration=fix` and would quietly repair
what should be observed failing.)

**Expect:**

- `typecheck` passes. Both closed sets are `as const` and feed exhaustive records, so any surviving reference
  to `workspace_entry` or to a deleted type is a compile error, not a silent leftover.
- `knip` reports no unused export. In particular, `describeWorkspaceEntry` must **not** appear: it loses its
  `profile-gate.ts` caller but keeps three inside `workspace-entries.ts`. If it is reported, something was
  over-deleted.
- `knip:orphans` passes with `knip.json` no longer naming `reachability-fake.ts`. Grep to be certain the
  config was corrected alongside the code:

  ```bash
  grep -rn "reachability" knip.json   # expect no output
  ```

- A repository-wide sweep finds no survivors:

  ```bash
  grep -rni "reachability\|workspace_entry\|createProfilesRouter\|ProfilesRouterOptions" \
    --include="*.ts" --include="*.tsx" apps packages knip.json
  ```

  Expect **no output**. `-i` catches every casing, including the `Reachability` in type names.

## Scenario 5 — The safety net is real (US3, FR-012)

The failure mode this change deliberately accepts. It must be verified, not assumed.

```bash
pnpm nx test sisyphus-executor -- workspace
```

**Expect** the existing phase-6 behaviour, untouched by this feature:

1. A clone that fails produces an `entry_checkout` failure naming the entry id, the repository, the branch and
   git's own message.
2. The agent is never started — `startAgentPhase` requires a `ReadyWorkspace`, which only a complete checkout
   constructs.
3. A second entry failing after a first succeeded unwinds the first, and a removal that itself fails is
   reported rather than swallowed.

If any of these three has regressed, this feature's premise has failed and the change should not ship.

## Full gate, as CI runs it

```bash
pnpm nx affected -t lint test typecheck
pnpm qlty:diff
```

`qlty:diff` must pass **without** any `QLTY_*` override. A change that is overwhelmingly deletion should
comfortably clear both the medium-severity and duplication thresholds; needing an override would mean something
was rewritten rather than removed.
