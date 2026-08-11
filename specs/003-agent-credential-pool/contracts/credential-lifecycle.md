# Contract: Credential Lifecycle and Administration

> **DEPRECATED (2026-08-11):** The Sisyphus workflow platform — including the executor, control plane, admin app, and agent credential pool described in this document — has been deprecated in favour of the Claude Code GitHub Action. This was because the GitHub Action is easier to maintain and configure, and more customizable than the bespoke infrastructure it replaced. This document is retained as a historical design record only; the packages and apps it describes have been removed from the repository.

**Feature**: `specs/003-agent-credential-pool` | **Date**: 2026-08-07

Registration, login, health, keep-alive and the pool view. Admin-only throughout (FR-004, FR-067).

## Login — the only step needing a human

Material must never reach the administrator (FR-070), which rules out any flow where they handle a file. The
platform therefore runs the agent's own login on its own infrastructure and captures the result server-side.

```
1. Admin registers a credential (name, group)          → state: awaiting_login
2. Platform provisions an ephemeral login environment  → no workspace, no bundle, agent CLI only
3. Admin drives the agent's login over a relayed session
4. Platform reads the resulting material on the instance and writes it to the secret store
5. Environment destroyed                               → state: available, last_login_at set
```

**Rules.**

- The environment carries **no workspace and no setup bundle** (FR-069). An interactive administrator session
  must not sit next to a client's repositories or credentials.
- It is destroyed on success, on failure, **and on abandonment** (FR-071) — an admin who closes the tab must not
  leave an instance running. A reaper bounded by wall-clock time, not by the session ending cleanly, because
  abandonment produces no event.
- It is never reachable by a workflow while it exists (FR-071).
- Material is written by the instance to the secret store via the machine surface, exactly as a rotation is —
  the same path, so login and rotation are not two mechanisms with two failure modes.
- **Re-login is this identical flow** (FR-072). Recovering a broken credential must not be a lesser-tested path
  than creating one.

## Health classification

One function, one module, tested against recorded provider responses:

| Provider signal                        | State         | Alert? | Recovery              |
| -------------------------------------- | ------------- | ------ | --------------------- |
| Rate limit / usage limit               | `cooling_off` | No     | Automatic (FR-076)    |
| Authentication / authorisation failure | `unhealthy`   | Yes    | Admin re-login        |
| Ambiguous                              | `cooling_off` | No     | Automatic, then retry |

**Ambiguity resolves to `cooling_off` deliberately.** A credential wrongly cooled off returns by itself on the
next retry; one wrongly marked unhealthy stays out of the pool until a human intervenes. The asymmetry favours
the recoverable error (research R5).

Where the provider states a retry time, it is stored as `cooling_off_until` and shown in the pool view. Where it
does not, the credential is still retried on a schedule rather than left cooling off indefinitely (FR-078).

## Keep-alive

```
every interval:
  for credential where state = 'available'
                   and enabled
                   and last_exercised_at < now() - threshold:
    exercise; record keep_alive_run; update last_exercised_at
```

**Rules.**

- Skips credentials that are **leased or disabled** (FR-036) — a leased one is being exercised by its workflow,
  and exercising it concurrently is the double-use this whole feature prevents (FR-038).
- Runs **regardless of group** (FR-035). Because selection is group-ordered, a lower-preference group can go
  untouched indefinitely, so this schedule — not LRU — is what actually guarantees liveness.
- Threshold is configuration, defaulting to 24h until the real idle-expiry window is measured (research R2).
- A failure classifies as above: `unhealthy` alerts, `cooling_off` does not (FR-037).
- `keep_alive_runs` accumulates the evidence from which the true expiry window can later be derived.

## Administrative operations

| Operation               | Effect                                                                 | Guard                  |
| ----------------------- | ---------------------------------------------------------------------- | ---------------------- |
| Register                | Creates in `awaiting_login`, in exactly one group                      | Admin (FR-004)         |
| Re-login                | Runs the login flow again; on success returns to `available`           | Admin (FR-010, FR-072) |
| Disable                 | Withholds from future selection; **does not interrupt a live holder**  | Admin (FR-006)         |
| Delete                  | Refused once used; disable instead                                     | Admin (FR-005)         |
| Force-release           | Releases the lease, resolves the affected workflow to a recorded state | Admin (FR-057)         |
| Create/rename group     | Admin (FR-060, FR-067)                                                 |                        |
| Delete group            | Refused while attached to a profile or holding a credential            | Admin (FR-066)         |
| Attach group to profile | Ordered attachment; a profile with none is unlaunchable                | Admin (FR-062, FR-065) |

Every one of these writes to the existing append-only configuration audit trail with the acting administrator
(FR-058, FR-067, SC-013).

**Force-release is the dangerous one.** It exists because a lease that is never released otherwise — a parked
workflow abandoned indefinitely — would hold capacity forever. It must resolve the affected workflow to a
recorded state rather than leaving it believing it still holds a credential, and the fence increment on the next
acquisition is what makes the old holder's writes rejectable if it is somehow still alive.

## Pool view

Admin-only (FR-053). Grouped by credential group, showing per credential: state, holder and hold duration,
last-used, last-exercised, expected return time while cooling off, and time until expiry where known.

**Holders are broken down by `running` / `paused` / `parked`** (FR-074). A parked holder shows no activity while
consuming capacity indefinitely, which makes a fully-parked pool look idle and behave as though it is full —
the single likeliest cause of unexplained exhaustion, and invisible without this breakdown.

The queue is shown **per group** (FR-054): depth and longest current wait, so an under-sized group is
distinguishable from an under-sized pool. This is the signal that answers "should we buy another seat", which is
the operational decision this design defers to humans.

## Alerts

Raised to administrators (FR-056): approaching expiry, became unhealthy, requires re-login, lease held beyond a
configurable expectation.

**Not raised**: waiting for a credential, cooling off, parking. These are engineer-facing states, reported in
the workflow view only (FR-079). Waiting and cooling off usually resolve within seconds, and alerting on them
would train people to ignore the channel.
