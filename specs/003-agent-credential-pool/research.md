# Phase 0 Research: Agent Credential Pool

**Feature**: `specs/003-agent-credential-pool` | **Date**: 2026-08-07

Ten unknowns, each resolved to a decision the design can be built on. Two of them (R1, R2) depend on provider
behaviour that cannot be read from documentation and must be measured — for both, the decision recorded here is
**the one that holds whichever way the measurement lands**, so neither blocks Phase 1. The experiment then tunes
a threshold rather than choosing an architecture.

---

## R1: How does a rotated refresh credential invalidate its predecessor?

**Decision.** Treat the predecessor as **dead the instant a rotation is observed**, and never rely on being able
to reuse it. Persist rotations write-through (R3), guard every write with a fencing value (R9), and treat a
credential whose stored material is rejected as unhealthy rather than retrying an older copy.

**Rationale.** There are two possible provider behaviours: immediate invalidation of the predecessor, or a grace
window in which both work. The design above is correct under both — it simply forgoes an optimisation that
would only exist under the second. Choosing the pessimistic rule costs nothing at runtime and removes the entire
class of "we assumed a grace window and there wasn't one" failures, which surface as a bricked seat needing a
human.

**What still must be measured, and why it is not blocking.** The measurement decides only _how bad_ an
unpersisted rotation is — whether a crash between rotation and persistence leaves a recoverable or a bricked
credential. That tunes the retry/alerting posture in `health/`, not the architecture. Experiment: register a
credential, force a refresh, capture both the pre- and post-rotation material, then attempt a call with the
predecessor and record whether it is accepted, and for how long.

**Alternatives considered.** _Optimistic reuse of the predecessor on failure_ — rejected: under immediate
invalidation it turns one failed request into two, and it can trip provider-side reuse-detection, which
typically revokes the whole chain. _Holding both copies and racing them_ — rejected for the same reason, plus it
doubles the material at rest for no gain.

---

## R2: How long does a credential survive disuse?

**Decision.** Do not depend on knowing. Exercise every credential on a **demand-independent schedule** with the
interval as configuration, defaulting conservatively (exercise anything idle beyond 24h), and record
`last_exercised_at` per credential so the true window becomes observable from production data rather than
assumed up front.

**Rationale.** FR-035 already makes keep-alive the mechanism that guarantees liveness, precisely because
least-recently-used selection cannot (a lower-preference group may see no traffic at all). A conservative
interval that is later relaxed is cheap; one that is too long is a silently expired seat discovered by a
workflow. Making the interval configuration rather than a constant means the measurement in R1's experiment
harness can tune it without a code change.

**What still must be measured.** The actual idle-expiry window, obtained by leaving a registered credential
untouched and probing periodically. Until it is known, the 24h default stands.

**Alternatives considered.** _Refresh on every allocation only_ — rejected: that is LRU, which R2 exists because
LRU cannot cover. _Never refresh, re-login when broken_ — rejected: converts a background job into an
unpredictable human interruption, which SC-009 exists to prevent.

---

## R3: How is a rotation detected on the instance?

**Decision.** Watch the agent's credential file for change, and on each change read it and POST it to the
machine surface under the lease's fencing value. Debounce, and **flush on every suspend path** so a rotation
observed moments before a pause or interruption is not lost.

**Rationale.** Write-through is what bounds the blast radius of a hard instance death to a single in-flight
rotation (R1). The suspend flush matters more than the debounce: `suspend()` already exists as the single
routine for pause, stop and spot interruption, so one flush there covers all three.

**Constraint discovered.** The on-disk location and format of the credential file are **platform-specific** —
on macOS the agent may store material in the OS keychain rather than a file, while the executor's target is
Linux, where it is a file. The watcher must therefore be written against the Linux behaviour and verified there;
a developer's local machine is not a valid test of this path. Local reading of the credential file was
deliberately not attempted during this research.

**Alternatives considered.** _Read-and-push once at teardown_ — rejected: loses the whole session's rotations if
the instance dies, which is exactly the failure mode this feature exists to prevent. _Poll on a timer_ —
rejected as strictly worse than watching, with the same code cost.

---

## R4: How does the platform-hosted login environment work?

**Decision.** Provision a short-lived instance with **no workspace and no bundle**, carrying only the agent CLI;
drive the agent's own login inside it over an SSM session relayed to the administrator; on completion, read the
resulting material from that instance and write it into the secret store server-side; destroy the instance.
Reuse the existing `compute.ts` seam for lifecycle and the existing scoped-credential mechanism for the
instance's authority to write back.

**Rationale.** FR-070 forbids the material reaching the administrator at all, which rules out any flow where
they copy a file. Running the agent's real login inside platform infrastructure is the only approach that
satisfies that while still letting a human complete an interactive provider flow. SSM is already a dependency
(`@aws-sdk/client-ssm`) and already how the platform reaches instances, so this adds a use, not a mechanism.

**Alternatives considered.** _Administrator logs in locally and uploads_ — rejected by the FR-070 clarification.
_Control plane implements the provider's OAuth directly_ — rejected: subscription logins generally do not offer
third-party app registration, so this is likely impossible and certainly fragile. _Reuse a workflow instance for
login_ — rejected: it would put a live workspace and a client's bundle next to an interactive admin session.

---

## R5: How is a provider rate limit distinguished from a broken credential?

**Decision.** Classify on the **provider's response**, in one module (`health/classify.ts`) with a single
exported function, defaulting to `cooling_off` when the signal is ambiguous. A rate-limit or usage-limit
response yields `cooling_off` with the provider's stated retry time where given; an authentication or
authorisation failure yields `unhealthy`.

**Rationale.** The two states have opposite operational meanings — one resolves itself, the other pages a human
(FR-075, FR-076) — so the classification is the load-bearing decision, and it belongs in exactly one place that
can be unit-tested against recorded responses. **Defaulting to `cooling_off` on ambiguity is deliberate**: a
credential wrongly cooled off returns by itself on the next retry, whereas one wrongly marked unhealthy stays
out of the pool until a human intervenes. The asymmetry favours the recoverable error.

**Alternatives considered.** _Treat every failure as unhealthy_ — rejected by the FR-075 clarification: it
drains a busy pool into false outages. _Infer from failure counts_ — rejected: a heuristic where an explicit
signal exists, and it would delay recovery by however long the counting window is.

---

## R6: Can an instance be stopped with its disk retained? — **conflict found**

**Decision.** Pause-with-stop applies to **on-demand instances only**. For spot, pause keeps the existing 002
behaviour: snapshot and terminate, resume from snapshot. Route this through the escape hatch FR-043 already
requires, so it is one code path rather than two.

**Rationale — two hard constraints in the current implementation.**

1. `apps/sisyphus-control-plane/src/aws/compute.ts` launches with
   `InstanceInitiatedShutdownBehavior: 'terminate'`, commented "an executor that shuts itself down must not
   leave a billable stopped instance behind". A pause therefore **cannot** be an instance-initiated shutdown —
   it must be a control-plane `StopInstances` call. The existing setting is correct and should not change: it is
   what stops a crashed executor leaking a stopped instance.
2. **`spot` is the default purchase mode** (`DEFAULT_PURCHASE_MODE`), and a one-time spot instance cannot be
   stopped by the user at all. Only on-demand, or a persistent spot request with interruption behaviour `stop`,
   supports it.

So FR-039 as written is unachievable for the majority of runs under current defaults. Degrading spot to
snapshot-and-terminate keeps the feature honest without changing the default purchase mode — which would be a
significant, unrelated cost decision.

**Consequence for SC-007** (resume ≥5× faster): achieved for on-demand runs; spot runs keep 002 resume
performance. This should be stated when the criterion is measured rather than discovered during acceptance.

**Alternatives considered.** _Change the default to on-demand_ — rejected here as out of scope: it is a cost
decision, not a credential-pool decision, and it belongs to whoever owns the spend. _Persistent spot with
`InstanceInterruptionBehavior: stop`_ — rejected for now: it changes reclamation semantics the existing
`suspend()` routine is built around, for a benefit that on-demand already provides. Worth revisiting
independently.

---

## R7: How is the new bootstrap phase added?

**Decision.** Insert `credential_install` between `setup_script` and `entry_checkout` in `BOOTSTRAP_PHASES`, and
ship it as a **migration**, not an append.

**Rationale.** The enum's own documentation states: "Order is part of the vocabulary, not a presentation detail
… Reordering these renames which step a stored row refers to, so it is a migration." Appending the new phase at
the end to dodge the migration would put credential installation _after_ `agent_start` in the vocabulary, which
is both wrong and undetectable later. Position matters: the credential must be installed after the bundle has
put the agent CLI in place, and before any workspace work begins.

**Alternatives considered.** _Fold credential install into `setup_script`_ — rejected: it re-entangles the
bundle with the agent credential, which is the entire thing this feature separates, and it would report a
credential failure as a bundle failure.

---

## R8: Where does credential material live?

**Decision.** **AWS Secrets Manager**, one secret per agent credential, accessed through an extended
`apps/sisyphus-control-plane/src/aws/secrets.ts`. Postgres stores the secret's identifier and never the
material.

**Rationale.** Both candidates are already dependencies and already wrapped. Secrets Manager wins on the two
things this material actually needs: native versioning (which gives the fencing check in R9 something to compare
against, and makes a bad rotation recoverable) and rotation-shaped access auditing. Parameter Store's
`SecureString` would work but has no version semantics worth the name for this use.

**Work required.** The existing wrapper is `SecretReader` — read-only, a single `read(secretId)`. Rotation
write-through needs a writer, so the seam gains `write` and the fake gains matching behaviour. This is the
smallest change consistent with how the codebase already isolates AWS.

**Alternatives considered.** _Parameter Store_ — rejected on versioning. _Postgres with application-level
encryption_ — rejected: it puts material in the database FR-011 forbids it in, and makes key management a new
problem.

---

## R9: How is exclusive use enforced against a partitioned holder?

**Decision.** A monotonically increasing `fence` integer on the credential row, incremented on every lease
acquisition. The lease carries the value it was issued. Every rotation write presents its fence, and the machine
surface **rejects any write whose fence is below the credential's current value**. Acquisition and increment
happen in one transaction with a conditional update, so two concurrent acquisitions cannot both win.

**Rationale.** This is the standard fencing-token construction, and it is what makes FR-020 real rather than
aspirational. Lease expiry alone is not sufficient and is in fact dangerous: a holder that is merely partitioned,
not dead, will happily keep writing. The fence makes its writes rejectable without needing to know whether it is
alive.

**Interaction with FR-019.** Because a lease is released only on terminal state or admin force-release — never
on pause, park or environment loss — the fence rarely advances in practice. It exists for the force-release and
reconciliation paths, which are exactly the cases where a previous holder may still be running.

**Alternatives considered.** _Time-based lease expiry with heartbeat_ — rejected: parked workflows legitimately
hold a credential without heartbeating, so expiry would reclaim live claims. _Advisory locks in Postgres_ —
rejected: they vanish on connection loss, which is the same partition problem one layer down.

---

## R10: Is "waiting for a credential" a new workflow state?

**Decision.** Add `awaiting_credential` to `WORKFLOW_STATES` and to `ACTIVE_WORKFLOW_STATES`. Do not overload
the existing `queued`.

**Rationale.** `queued` already means "admitted, waiting on the concurrency ceiling", and FR-029 requires the
platform to report _which_ scarcity is biting and name the groups searched — a distinction that collapses if
both conditions share a state. Adding to `ACTIVE_WORKFLOW_STATES` is what keeps the reconciliation sweep
treating these runs as live so their reservations are not swept away.

**Consequence.** A workflow can now wait on two different things in sequence, so the panel must render both
distinctly. This is the FR-029/FR-054 reporting requirement, and it is why they are specified per group.

**Alternatives considered.** _Reuse `queued` with a reason column_ — rejected: every existing query filtering on
`queued` would silently change meaning, and state is what the panel and reconciler both branch on.

---

## Summary of decisions

| ID  | Decision                                                                | Blocking? |
| --- | ----------------------------------------------------------------------- | --------- |
| R1  | Treat predecessor credential as dead on rotation; write-through + fence | Resolved  |
| R2  | Demand-independent keep-alive, configurable, 24h default                | Resolved  |
| R3  | Watch credential file; flush on every suspend path; verify on Linux     | Resolved  |
| R4  | Ephemeral bundle-less login instance, SSM relay, server-side capture    | Resolved  |
| R5  | Classify on provider response; default to `cooling_off` when ambiguous  | Resolved  |
| R6  | Stop-with-disk for on-demand only; spot degrades to snapshot path       | Resolved  |
| R7  | `credential_install` inserted mid-enum as a migration                   | Resolved  |
| R8  | Secrets Manager, one secret per credential; extend seam with `write`    | Resolved  |
| R9  | Fencing integer, conditional-update acquisition                         | Resolved  |
| R10 | New `awaiting_credential` workflow state                                | Resolved  |

**Two measurements remain outstanding (R1, R2)** and are deliberately non-blocking: each tunes a threshold or an
alerting posture inside a single module, and the design is correct under either outcome. They should be run
against the first registered credential, before the pool carries real work.
