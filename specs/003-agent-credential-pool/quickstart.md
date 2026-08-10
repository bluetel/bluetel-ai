# Quickstart: Validating the Agent Credential Pool

**Feature**: `specs/003-agent-credential-pool` | **Date**: 2026-08-07

Runnable scenarios that prove each slice works end to end. Design lives in [data-model.md](./data-model.md) and
[contracts/](./contracts/); this is the run-and-verify guide.

Builds on [002's quickstart](../002-sisyphus-workflow-platform/quickstart.md) — its prerequisites (workspace
install, per-developer AWS stage, migrations, panel domain, Google OAuth redirect) all still apply and are not
repeated here.

---

## Additional prerequisites

```bash
nvm use                                   # v24.15.0
pnpm install --frozen-lockfile            # no new dependencies — nothing to add

SISYPHUS_DATABASE_URL='postgres://…' pnpm nx run sisyphus-api:migrate
```

The migration includes **two enum changes** ([data-model](./data-model.md#enum-migrations)):
`workflow_state` gains `awaiting_credential`, and `bootstrap_phase` gains `credential_install` **inserted
mid-order**. The second is a reorder, so verify it landed before trusting any bootstrap-phase row:

```bash
psql "$SISYPHUS_DATABASE_URL" -c "SELECT unnest(enum_range(NULL::bootstrap_phase))"
# expect credential_install between setup_script and entry_checkout
```

**One agent identity to register.** You need a real login to register a credential — that is the point of the
feature and there is no fixture substitute for scenario 2 onward. Scenarios 1 and 7 run without one.

---

## Scenario 1 — Groups and attachments gate a launch

**Proves**: FR-060–FR-068, FR-065. Runs with no credentials at all.

```bash
pnpm nx test sisyphus-api --testPathPattern 'credential-group|profile-credential'
```

Then in the panel, as an admin:

1. Create two groups, `seats-a` and `overflow`.
2. Attach only `seats-a` to a profile → saves.
3. Detach every group from a profile → **save is refused**, naming the missing attachment (FR-065).
4. Delete a group that is attached → **refused**, offering disable instead (FR-066).

**Check**: the refusal in step 3 happens at configuration time, not at launch. A profile that saves must be
launchable.

Then, with credentials registered in both groups, launch repeatedly under a profile attached only to `seats-a`.
**Check** no credential from `overflow` is ever used (FR-063, SC-016) — assert against the lease rows, which is
the only record that cannot be fooled by a coincidence of timing.

---

## Scenario 2 — Register a credential end to end

**Proves**: FR-007–FR-010, FR-069–FR-072, SC-001.

In the panel: register a credential into `seats-a`, complete the login in the relayed session.

**Check**:

- State goes `awaiting_login` → `available`, `last_login_at` set.
- The login environment is **gone** afterwards (`aws ec2 describe-instances`, filtered to the login tag).
- **No material was displayed or downloadable at any point** (FR-070, SC-014) — inspect the panel's network
  responses, not just the UI.
- Whole flow completes in under 5 minutes (SC-001).

Then abandon a second registration mid-flow — close the tab. **Check** the environment is still reaped
(FR-071); this is the case that produces no completion event, so it is the one most likely to leak.

---

## Scenario 3 — A workflow leases, rotates, releases

**Proves**: FR-015–FR-019, FR-030–FR-032, FR-049–FR-051, SC-002.

Launch a workflow under the profile attached to `seats-a`.

**Check, in order**:

| Point          | Expect                                                                            |
| -------------- | --------------------------------------------------------------------------------- |
| At admission   | Credential `held`, lease row exists, **before** any instance exists               |
| Bootstrap      | `credential_install` phase reported between `setup_script` and `entry_checkout`   |
| During the run | `reportCredentialRotation` accepted at least once — the agent rotates             |
| Job envelope   | **Contains no material** (FR-012) — decode the instance's user-data               |
| At terminal    | Lease released, credential `available`, `workflows.agent_credential_id` still set |

The envelope check is worth doing by hand rather than trusting a test: user-data is readable from the instance
metadata service, so material there would be exposed to anything running on the box.

---

## Scenario 4 — Exclusivity holds under race

**Proves**: FR-017, FR-020, SC-003. **The scenario that matters most** — the feature's whole reason for
existing.

```bash
pnpm nx test sisyphus-control-plane --testPathPattern 'credentials/lease'
```

Then, against a pool of N credentials, launch 2N workflows simultaneously.

**Check**:

- Exactly N run; the rest sit in `awaiting_credential` (FR-024).
- **No credential ever appears on two live leases** — the partial unique index makes this a database guarantee,
  so a violation is a schema defect, not a timing one.
- No waiting workflow has an instance provisioned against it (FR-025, SC-004) — verify against EC2, not against
  the panel.

Then force-release a lease while its instance is still running, and have that instance attempt a rotation
write. **Check** it is rejected with `stale_fence` (FR-020) and the newer material survives.

---

## Scenario 5 — Pause, resume, park

**Proves**: FR-039–FR-047, FR-073, SC-007, SC-008.

Run **twice** — once with an `on_demand` profile, once with `spot` — because they take different paths
(research R6).

| Mode        | Pause                                | Resume                       |
| ----------- | ------------------------------------ | ---------------------------- |
| `on_demand` | Instance **stopped**, disk retained  | Started; no restore          |
| `spot`      | Snapshot + terminate (002 behaviour) | Fresh instance from snapshot |

**Check in both**:

- Credential lease **retained** through pause (FR-040) and through park (FR-073).
- Compute cost zero while paused (SC-008) — instance is `stopped` or absent, not `running`.
- After the idle limit: workflow `parked_resumable`, instance and disk gone, **credential still held**, and the
  pool view shows the holder as `parked` (FR-074).
- Resume of a parked workflow **never waits for a credential** (FR-046).
- The run used **exactly one credential end to end** across pause, park and every environment rebuild (SC-018)
  — assert `workflows.agent_credential_id` is unchanged and only one lease row exists for it.
- With an unresumable snapshot, parking **refuses** to release the instance and disk, raising instead (FR-045).

**SC-007** (resume ≥5× faster) is measurable on the `on_demand` path only. Record the spot figure separately
rather than reporting a single number — the two paths genuinely differ.

---

## Scenario 6 — Cooling off versus unhealthy

**Proves**: FR-033, FR-037, FR-075–FR-078, SC-019, SC-020.

```bash
pnpm nx test sisyphus-control-plane --testPathPattern 'credentials/health'
```

The classification is unit-tested against recorded provider responses; do not attempt to provoke a real rate
limit as an acceptance step.

**Check**:

- A rate-limit response → `cooling_off`, **no alert**, returns automatically (SC-019).
- An auth failure → `unhealthy`, alert raised, excluded until re-login.
- An ambiguous response → `cooling_off` (the deliberate asymmetry, research R5).
- An unhealthy credential is excluded from selection **before** it can be issued to a second workflow (SC-010)
  — assert on the selection query, not on the second workflow's failure.
- Re-login returns a broken credential to service in under 5 minutes, disturbing no run on any other credential
  (SC-012).
- A run whose credential cools off **waits rather than failing** (FR-077, SC-020), and its owner sees a provider
  limit rather than a stall.

---

## Scenario 7 — Keep-alive keeps an untouched credential alive

**Proves**: FR-034–FR-038, SC-009. Needs no workflows.

With two groups attached to one profile in order `[seats-a, overflow]`, send traffic to that profile only.
`overflow` receives nothing — that is the point.

**Check**:

- Selection prefers `seats-a` and only reaches `overflow` when `seats-a` is fully held (FR-064).
- Within a group, LRU picks the least recently used (FR-034).
- After the threshold, **every** credential has been exercised — including every member of `overflow`, which no
  workflow ever touched (FR-035). This is the assertion that proves LRU alone would not have sufficed.
- Keep-alive **skips leased credentials** (FR-036, FR-038).
- `keep_alive_runs` accumulates rows — the evidence from which the real idle-expiry window gets measured
  (research R2).

---

## Scenario 8 — The pool view answers the operational question

**Proves**: FR-053–FR-058, FR-074, FR-079, SC-011, SC-013.

With credentials in mixed states and at least one workflow waiting:

**Check**:

- Every state is distinguishable, grouped by credential group.
- Holders are broken down `running` / `paused` / `parked` (FR-074).
- Queue depth and longest wait shown **per group** (FR-054) — an admin can tell in under 30 seconds _which_
  group to grow (SC-011).
- FR-029's four waiting reasons are distinguished: all held, all cooling off, all unhealthy/disabled, or no
  credentials at all.
- A non-admin is refused the view entirely.
- **No engineer-facing notification** fired for waiting, cooling off or parking (FR-079) — check the
  notification log is empty for these, while admin alerts still fire.

---

## Full gate before merge

```bash
pnpm nx affected -t lint test typecheck
pnpm qlty:diff
```

Both must be green with no threshold overrides, per constitution principle IV.

---

## Outstanding measurements

Two provider behaviours are unresolved by design (research [R1](./research.md#r1), [R2](./research.md#r2)) and
should be measured against the first registered credential **before the pool carries real work**:

1. **Rotation invalidation** — does a superseded credential stop working immediately, or tolerate a window?
   Tunes retry and alerting posture in `health/`.
2. **Idle-expiry window** — how long does an unused credential survive? Tunes the keep-alive threshold, which
   defaults conservatively to 24h until known.

Neither blocks implementation: the design is correct under either outcome. Both change a configured threshold,
not an architecture.
