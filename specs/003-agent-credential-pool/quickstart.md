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

You complete that login **inside a platform-provisioned environment**, over a relayed Session Manager terminal
([Scenario 2](#scenario-2--register-a-credential-end-to-end)), so you need the Session Manager plugin installed
locally and `ssm:StartSession` permitted to your role. You do **not** need `secretsmanager:CreateSecret`: nothing
about a login is done by hand any more, and no copy of the credential is ever on your machine.

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

**Proves**: FR-004–FR-011, FR-061, FR-069–FR-072, SC-001, SC-014.

**Prerequisite**: one real agent login you are willing to complete interactively, an AWS stage with
`ssm:StartSession` permitted to your role, and the Session Manager plugin installed locally
(`session-manager-plugin --version`). Scenarios 1 and 7 need none of these; everything from here does.

> **This scenario replaced Scenario 2a**, in which an operator wrote the material into Secrets Manager with the
> AWS CLI and the panel recorded the name it was filed under. That shortcut satisfied FR-011 and FR-070 — the
> material never transited the panel — but left FR-069, FR-071, FR-072 and SC-001 unmet, and let a seat reach
> `available` without a login ever having happened. `admin.credentials.adoptSecret`, its panel field and that
> scenario were deleted together in Phase 7.

### 1. Register the seat, in the panel

As an admin, on `/admin/credentials`: register `seat-one` into the group `seats-a` created in Scenario 1.

**Check**, before doing anything else:

- The row reads `awaiting_login`, `usable: no`, `secret: none recorded`.
- It says **why** it is withheld — "no login has been completed for it, so there is nothing for a run to fetch"
  (FR-009).
- The registration is on the configuration trail with the acting administrator against it (FR-004, SC-013):

  ```bash
  psql "$SISYPHUS_DATABASE_URL" -c \
    "SELECT entity_type, action, actor_user_id, detail FROM configuration_audit
       WHERE entity_type = 'agent_credential' ORDER BY created_at DESC LIMIT 1"
  ```

**Check it is genuinely unselectable, against the selection path** rather than against its state column — a seat
that merely _reads_ `awaiting_login` proves nothing about what an allocator would pick up:

```bash
psql "$SISYPHUS_DATABASE_URL" -c \
  "SELECT c.name FROM agent_credentials c
     JOIN credential_groups g ON g.id = c.credential_group_id
    WHERE c.state = 'available' AND c.secret_id IS NOT NULL
      AND c.enabled AND c.archived_at IS NULL AND g.enabled AND g.archived_at IS NULL"
# expect seat-one to be absent
```

### 2. Start the login

Follow **Log in** on the seat's row to `/admin/credentials/{id}/login`, and press **Start login**. Start a stopwatch
— SC-001 is five minutes from here to a usable seat.

**Check the environment is isolated from workflow execution** (FR-069, FR-071). The login instance carries
`sisyphus:credential-login` and **no** `sisyphus:workflow-id`, which is what keeps it out of every set the
workflow machinery reads:

```bash
aws ec2 describe-instances \
  --filters "Name=tag-key,Values=sisyphus:credential-login" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].[InstanceId,Tags]'
# expect exactly one instance, tagged with the credential id and an ISO-8601 sisyphus:login-expires-at

aws ec2 describe-instances \
  --filters "Name=tag-key,Values=sisyphus:workflow-id" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId'
# expect the login instance to be ABSENT — the two populations are disjoint, so no reconciliation
# sweep can attribute it to a run and no run can be scheduled onto it
```

**Check the seat has not moved.** It is still `awaiting_login`, still `usable: no`, still absent from the
selection query above. A login in progress is not a state — FR-008 admits `available` only on a _proved_ login,
so there is nothing to unwind when an attempt is abandoned.

### 3. Complete the agent's login inside the relayed session

Attach a terminal to the instance the page names, and complete the agent's own login inside it:

```bash
aws ssm start-session --target "$LOGIN_INSTANCE_ID"
```

The environment holds **no workspace and no setup bundle** — confirm it, because FR-069's isolation claim is
that an interactive session is not sitting next to a client's repositories:

```bash
ls /workspace 2>&1     # expect: No such file or directory
ls /var/lib/sisyphus/login   # expect: the directory the agent writes its credential into, and nothing else
```

Then run the agent's login as you would anywhere, and answer its prompts. It writes its credential to
`/var/lib/sisyphus/login/credential`.

### 4. Watch the capture land

Return to the login page. Within one poll interval:

**Check**:

- The seat's state goes `awaiting_login` → `available`, with `last_login_at` set and `usable: yes`.
- It now appears in the selection query from step 1.
- The secret exists, under the prefix and the **credential id** — not its name, which is renameable:

  ```bash
  aws secretsmanager describe-secret \
    --secret-id "${SISYPHUS_AGENT_CREDENTIAL_SECRET_PREFIX}/${CREDENTIAL_ID}" \
    --query '[Name,ARN]'
  ```

- The login environment is **gone** (FR-071):

  ```bash
  aws ec2 describe-instances \
    --filters "Name=tag-key,Values=sisyphus:credential-login" \
              "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId'
  # expect empty
  ```

- **No material appeared in any panel network response** (FR-070, SC-014). Inspect the responses, not the UI.
  With the network tab recording from step 2, search every response body for the credential you just created.
  There is nothing to find: `startLogin` answers an instance id, two timestamps and a Session Manager session
  handle, and `loginStatus` answers the same minus the handle. The material went from the instance to Secrets
  Manager without the panel on the path.
- Stop the stopwatch. **SC-001**: under five minutes, with no operator shell and no bundle.

### 5. Abandon a second attempt — the case that produces no event

Register `seat-two`, start its login, and **close the tab**. Do nothing else: no cancel, no logout, no report of
any kind. This is the case FR-071 exists for, and the only thing that changes from here is the clock.

Wait past the environment's deadline (`sisyphus:login-expires-at` on the instance, fifteen minutes by default),
or invoke the reaper directly.

**Check**:

- The instance is **gone** — the `describe-instances` query from step 4 is empty again.
- The seat is exactly where it was: still `awaiting_login`, still no secret, still no `last_login_at`.
- It now carries a reason an administrator can act on (FR-009), visible on the seat's row:

  ```bash
  psql "$SISYPHUS_DATABASE_URL" -c \
    "SELECT name, state, secret_id, last_failure_reason FROM agent_credentials WHERE name = 'seat-two'"
  # expect state awaiting_login, secret_id null, and a reason ending "start the login again"
  ```

- Starting the login again works, and clears that reason on success.

### 6. Re-login is this same flow (FR-010, FR-072)

Take a seat to `unhealthy` — Scenario 6 does it through a real provider failure — and follow **Log in again**
from its row. It is the **same procedure, the same environment and the same capture**; the only difference is
that the secret already exists, so the material is stored into it as a new version through the same
`persistRotation` a rotation uses, rather than creating one.

**Check** the seat returns to `available` with `last_login_at` moved and its failure reason cleared, and that
`describe-secret --version-stage AWSPREVIOUS` still holds what was there before.

### 7. The two administrative refusals

- Disable the seat. **Check** it leaves the selection query while its row is otherwise untouched (FR-006). With a
  run holding it, the run keeps it — assert against `credential_leases`, where `released_at` is still null.
- Delete a seat that has ever been leased. **Check** it is **refused**, naming how many times it was leased and
  offering disable instead (FR-005). Delete one that never has: it is archived, not removed, and still listed
  under "include archived".

```bash
pnpm nx test sisyphus-api --skip-nx-cache -- --run admin/credentials
pnpm nx test sisyphus-control-plane --skip-nx-cache -- --run credentials/login
```

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
