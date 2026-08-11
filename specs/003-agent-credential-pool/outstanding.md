# Outstanding: what cannot be finished without a real stage

> **DEPRECATED (2026-08-11):** The Sisyphus workflow platform — including the executor, control plane, admin app, and agent credential pool described in this document — has been deprecated in favour of the Claude Code GitHub Action. This was because the GitHub Action is easier to maintain and configure, and more customizable than the bespoke infrastructure it replaced. This document is retained as a historical design record only; the packages and apps it describes have been removed from the repository.

**Status**: open. Four tasks — **T123, T124, T125 and T127** — remain unticked in
[tasks.md](./tasks.md) and this file is why. Every other task in the feature (T001–T122, T126,
T128, T129) is done.

---

## Why these four are here and not merely late

They require two things this repository does not contain and cannot simulate:

1. **A deployed AWS stage.** Not a mock, not LocalStack, not the in-memory
   `createFakeComputeProvisioner`: an account where `RunInstances` really launches a box, where
   Secrets Manager really holds material, and where an instance really is stopped and started
   again. Three of the four measurements below are about wall-clock behaviour of real
   infrastructure, and a fake that answered them would be answering with the number somebody typed
   into it.
2. **A real agent-provider account.** T124 and T125 are questions about what _the provider_ does
   with a rotated or an unused login. Nothing in this repository knows the answer, and nothing in
   it can find out. `research.md` says so explicitly — R1 and R2 are recorded as unresolved by
   design, not as gaps somebody forgot to fill.

The design does not depend on the answers. Every one of them **tunes a configured threshold or
completes a reported figure**; none of them changes an interface, a schema or a control flow. That
is the reason the feature was built without them and the reason they are safe to carry.

What follows is written so the next person can pick each one up without re-deriving it: what it
needs, what to measure, what the answer changes, and what is assumed in its place today.

---

## T123 — Walk quickstart scenarios 1–8 against a real stage

**Needs**: a deployed stage (panel, control plane and executor), one real setup bundle, one real
agent-provider login to drive interactively, and an operator with administrator access to the
panel.

**What to do**: [quickstart.md](./quickstart.md), scenarios 1 to 8, in order, recording the
observed result of each command rather than ticking it. Two steps inside it are worth calling out
because they are the ones a hurried walkthrough skips:

- **The abandoned-login reap** (quickstart Scenario 2 §5, task T071). Start a login, close the tab,
  and touch nothing else. It is the only path in the feature that produces **no event at all** —
  nothing is reported, nothing fails, and only the wall clock moves. Confirm the login instance is
  gone after `SISYPHUS_LOGIN_TTL_MINUTES` and that the seat is back to `awaiting_login` with a
  reason recorded against it.
- **The by-hand envelope check** (task T122). See "What T122 covers already" below — the decode has
  been done against a real envelope produced by the real provisioning path, but **not** against a
  running instance's metadata service. On a real stage, from inside a running instance:

  ```bash
  TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
  curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
    http://169.254.169.254/latest/user-data | base64 -d | jq .
  ```

  Read the output with your own eyes. `agentCredential` must contain exactly `credentialId` and
  `leaseFence`, and there must be nothing anywhere in the document that could be presented to the
  agent provider as a login.

**What depends on it**: T127 below, which cannot be recorded until scenario 5's two resume paths
have been timed. Nothing in the code.

**Assumed in its place today**: that the scenarios behave as their automated counterparts do. Every
scenario has suites standing behind it against a real Postgres and a fake compute seam, so what is
unproven is the AWS behaviour underneath — chiefly that `StopInstances` retains the volume, that
`StartInstances` brings the same disk back, and that a one-time spot instance refuses the stop (the
whole reason the spot path degrades to the snapshot route).

---

## T124 — The R1 measurement: does a rotated credential invalidate its predecessor?

**Needs**: a real agent-provider account, and a registered seat that has completed a login.

**What to measure**:

1. Register a credential and complete its login.
2. Copy the stored material (from the secret store, server-side — never through the panel).
3. Force the agent to refresh, so the provider issues a successor.
4. Attempt a provider call with the **predecessor**. Record: is it refused immediately? If it is
   accepted, keep trying at a fixed interval and record how long the grace lasts.

**What the answer changes**: retry and alerting posture in
`apps/sisyphus-control-plane/src/credentials/health/`. Specifically whether a failure observed
moments after a rotation should be classified as `unhealthy` (an administrator is paged) or
absorbed as a rotation race that will clear on its own. It changes a threshold, **not an
architecture** — the fence in `credentials/lease/fence.ts` and the write-through in
`credential/rotation-watch.ts` are correct under either answer, which is exactly why the feature
did not wait for this.

**Assumed in its place today**: the conservative reading — **a predecessor is dead the moment a
successor exists**. The platform writes rotations through immediately rather than batching them,
and treats a rejected credential as a real failure. If the measurement shows a grace window, the
change is to tolerate a rejection inside it rather than classify on the first one.

---

## T125 — The R2 measurement: the true idle-expiry window

**Needs**: a real agent-provider account, a registered seat, and **patience measured in days** —
this is the one task here whose cost is elapsed time rather than access.

**What to measure**: register a credential, complete its login, and then leave it strictly alone —
no workflow, and keep-alive disabled or pointed elsewhere for the duration. Probe it on a fixed
schedule (hourly is ample) and record the first probe that fails. That interval is the real
expiry-through-disuse window.

**What the answer changes**: exactly one value —
**`SISYPHUS_KEEPALIVE_IDLE_HOURS`**. Set it from the measured window with a comfortable margin
(half the measured value is the obvious choice) rather than from the guess it currently carries.

**Assumed in its place today**: **24 hours**, chosen conservatively and documented as a guess in
`apps/sisyphus-control-plane/src/env-schemas.ts`. Being wrong in the safe direction costs a keep-alive
exercise more often than necessary; being wrong in the other direction is SC-009's failure — a seat
that expired through disuse — and is why the default errs low.

**Note on what the guess protects**: keep-alive is not an optimisation that LRU selection makes
redundant. LRU only rotates use _within_ the group being drawn from, so an overflow group attached
to a quiet profile can go untouched indefinitely. Keep-alive is the only thing that guarantees
liveness under partitioning, so this threshold is load-bearing even though it is a guess.

---

## T127 — Record SC-007 as two figures

**Needs**: T123's scenario 5, walked on a stage that can provision **both** purchase modes.

**What to record**: two separate numbers, never one blended one.

| Figure             | What to time                                                              | Target                                        |
| ------------------ | ------------------------------------------------------------------------- | --------------------------------------------- |
| `on_demand` resume | Pause → `StartInstances` on the same box → first agent turn               | **≥ 5× faster** than an equivalent cold start |
| `spot` resume      | Pause (degrades to terminate) → fresh instance from snapshot → first turn | 002's resume performance, no better claimed   |

Time an equivalent **cold start** on the same stage as the denominator, or the ratio means nothing.

**Why two and not one**: `003/FR-039` cannot be satisfied for a one-time spot instance at all — EC2
refuses to stop one — so a spot pause takes the snapshot-and-terminate path and is a rebuild rather
than a resume. Spot is the platform default. A single blended figure would therefore be dominated
by the path SC-007's 5× claim was never about, understating the on-demand improvement and
overstating what a default-configured run actually gets. `pause-instance.ts` writes the path taken
onto the run's `paused` timeline row precisely so this measurement can tell the two apart after the
fact.

**Assumed in its place today**: nothing is claimed. SC-007 is unreported rather than estimated, and
should stay that way until it is measured — an invented figure in a success criterion is worse than
an absent one, because the absence is visible.

---

## What T122 covers already, so it is not re-done here

The material-leak audit **is** complete, including the by-hand decode, and is recorded here only so
that the T123 walkthrough does not repeat work or assume it was skipped.

- The cross-cutting suite is
  `packages/sisyphus-api/src/server/admin/material-leak-audit.test.ts`. It moves real material
  through both machine procedures and then sweeps **every text, varchar and JSON column in the
  schema**, asked of `information_schema` rather than listed, so it covers tables that do not exist
  yet. It carries a planted-leak negative control, so a sweep that had stopped searching correctly
  would fail rather than pass silently.
- The by-hand decode was performed against a **real envelope produced by the real provisioning
  path** — `startWorkflow` against Postgres, base64-encoded exactly as `aws/compute.ts` encodes it
  for `RunInstances`, then decoded by hand. What it contained: `workflowId`, `sessionId`,
  `machineSurfaceUrl`, the short-lived `scopedCredential` JWT, `agentCredential` as
  `{credentialId, leaseFence}` and nothing else, a `setupBundle` reference (`s3Key`,
  `contentDigest`, `version`), the workspace entries, the job spec, the assembled prompt, and
  `mode`. No agent material, no repository token, no signing secret.
- The decoded JWT's own claims were read: `iss`, `aud`, `sub: workflow:<id>`, `jti`, `iat`, `nbf`,
  `exp`. Its `exp` is **twelve hours** out — `SCOPED_CREDENTIAL_MAX_LIFETIME_MS`, the hard ceiling —
  which is a different bound from the fifteen-minute database-side validity that must be renewed
  (`SCOPED_CREDENTIAL_WINDOW_MS`). Both are real and they are not the same thing;
  `jobs/job-envelope.ts` now says so, having previously named only the fifteen minutes.

What remains for T123 is the one thing a repository cannot do: read the same document off a running
instance's metadata service, which is the channel the guarantee is actually about.
