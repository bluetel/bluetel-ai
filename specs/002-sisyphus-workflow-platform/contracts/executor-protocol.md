# Contract: Executor Protocol (`apps/sisyphus-executor`)

**Feature**: `specs/002-sisyphus-workflow-platform` | **Date**: 2026-08-05

What the control plane hands the executor, what it must do in what order, and how it reports back.

## Invocation

The control plane passes a job envelope via instance user-data. It contains **no long-lived secrets** — only the
scoped credential and the references needed to fetch everything else.

```
{
  workflowId, sessionId,                    # platform-assigned (FR-052)
  machineSurfaceUrl, scopedCredential,      # workflow-scoped, machine-surface-only (FR-037)
  setupBundle: { s3Key, contentDigest, version },
  workspace: { root: "/workspace", entries: [{ entryId, repositoryUrl, baseBranch, subdirectory, isPrimary }] },
  job: { model, turnCap, spendCap, workflowType },
  prompt: { preamble?, intro?, ticket?, assembled },
  resumeFromSnapshot?: { s3Key, sessionId },
  mode: "workflow" | "validation"           # FR-147
}
```

**Validation-run mode** exists because FR-147 requires proving a bundle with **no** ticket, workspace or prompt —
which the workflow envelope cannot express, since `workspace`, `job` and `prompt` are all mandatory. In
`validation` mode only `setupBundle`, `machineSurfaceUrl` and `scopedCredential` are supplied; the executor runs
bootstrap phases 2–5, reports per-phase results against the bundle version, and tears down without ever reaching
phase 6 or 7. It reports to `validationRuns`, not to a workflow row — so `workflows.owner_user_id`,
`assembled_prompt` and `workspace_version_id` stay non-null for real runs rather than being loosened to
accommodate a validation.

Configuration reaches the executor through this envelope, **not** through the environment. Its `env` schema
covers only what the instance itself needs (region, machine surface URL, bucket names) — the scoped credential
and every job parameter arrive here, so nothing job-specific is ever readable from `process.env`.

## Pinned paths — non-negotiable

| Path                        | Why                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/workspace`                | Workspace root. **Fixed**, because the agent derives its session directory from the absolute cwd; an unpinned path makes a restored session unfindable (R2, FR-051) |
| `/workspace/<subdirectory>` | One per workspace entry (FR-109)                                                                                                                                    |
| `/workspace/.agent-config`  | `CLAUDE_CONFIG_DIR` relocated **inside** the root so the whole state tree is one tar target (FR-051)                                                                |

A snapshot is a single `tar.zst` of `/workspace`. That is only true while all three hold.

## Bootstrap — ordered, individually timed

Each phase reports start and outcome via `reportBootstrapPhase`, and each has **its own** timeout. Exceeding one
fails the workflow **naming that phase** rather than emitting a generic bootstrap timeout (FR-145, FR-146).

| #   | Phase             | Action                                                                                 | Failure                                                                                    |
| --- | ----------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | `provisioning`    | Recorded by the control plane before hand-off                                          | Capacity/constraint reported, no instance left running (FR-036, FR-039)                    |
| 2   | `bundle_download` | Fetch archive from S3                                                                  | Missing archive → bundle-setup failure (FR-088)                                            |
| 3   | `bundle_verify`   | sha256 against registered digest                                                       | Mismatch → bundle-setup failure; agent never starts (FR-088)                               |
| 4   | `bundle_unpack`   | Unpack; assert executable `setup.sh` at root                                           | Absent/non-executable → bundle-setup failure (FR-083, FR-088)                              |
| 5   | `setup_script`    | Run `setup.sh`; capture output through the sanitiser                                   | Non-zero exit → bundle-setup failure (FR-088). Output redacted before persistence (FR-089) |
| 6   | `entry_checkout`  | Per entry: clone at declared branch into declared subdirectory; record resolved commit | Any entry fails → workflow fails naming the entry; **no partial workspace** (FR-112)       |
| 7   | `agent_start`     | Start the agent with the pinned session id                                             | —                                                                                          |

**Rules.** Phases 2–5 run once regardless of entry count, and **run on a restore boot too** — that is what
reinstalls the credentials a snapshot deliberately does not carry (see [Snapshot](#snapshot-and-restore)). Phase 6
is fully sequenced before phase 7 — the agent never starts against an incomplete workspace (FR-112). On
`resumeFromSnapshot`, restore replaces only phases 6 and 7 (see [Restore](#restore)).

## Agent adapter boundary

The single seam that makes R1's fallback a swap rather than a rewrite. Both the NDJSON-stdin implementation and
the Agent SDK fallback satisfy it.

```ts
interface AgentAdapter {
  start(opts: { sessionId: string; cwd: string; model: string; prompt: string }): Promise<void>
  sendTurn(body: string): Promise<void> // the correction path — FR-044, FR-049
  quiesce(): Promise<void> // reach a turn boundary; do not kill
  stop(opts: { force: boolean }): Promise<void>
  readonly output: AsyncIterable<AgentFrame>
  readonly usage: { turns: number; spend: number }
}
```

**Rules.** `sendTurn` MUST NOT restart the process (FR-044). `quiesce` reaches a turn boundary without
terminating, which is what makes pause non-destructive (FR-049). Frames are parsed defensively: an unrecognised
frame is logged and skipped, never fatal — the wire format is only lightly documented (R1).

CLI invocation for the primary implementation:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
       --session-id <uuid> --permission-mode bypassPermissions \
       --max-turns <turnCap>
```

`--output-format stream-json` requires `--verbose`. `--resume` appears **only** on the restore path.

## Supervision — one suspend path

Pause, spot-interruption warning and stop-for-later are the same routine (FR-054, R3):

```
suspend(reason: 'pause' | 'interruption' | 'stop'):
  1. quiesce()                            # turn boundary, process alive
  2. snapshot()                           # tar /workspace → S3
  3. registerSnapshot(boundary = reason)  # machine surface
  4. mark parked_resumable
  5. release compute                      # immediate for interruption/stop; on ceiling for pause
```

> **Amended by `003/FR-039`.** Two lines of this sketch changed and the rest is unchanged. Step 1's
> "process alive" is now true only for an interruption or a stop: a **pause ends the agent** as well,
> because the snapshot has just been taken and an agent still writing would leave the disk and the
> snapshot disagreeing. Step 5's "on ceiling for pause" is now "the control plane stops the instance
> from outside" — an executor cannot stop its own instance, because every instance the platform
> launches carries `InstanceInitiatedShutdownBehavior: 'terminate'` and would destroy the disk the
> pause exists to keep. The idle ceiling still exists as the backstop for a stop that never came.
> One step was also added ahead of the snapshot: **flush any agent credential rotation** the watcher
> has observed but not yet written through (`003/FR-030`).

**Step 2 can fail, and it must not be allowed to lose work.** If durable storage is unreachable at a snapshot
boundary, the run **parks and retries** with backoff rather than continuing unsnapshotted or terminating
(FR-082). Parking holds the agent at the turn boundary reached in step 1 — the process stays alive and no
further turns are consumed, so the cost of parking is storage retries, not inference. Every failed attempt is
reported through `reportSnapshotPark(boundary, attempt, maxAttempts, nextDelayMs)` — the counterpart to step 3,
and **not** the `parked_resumable` outcome: the run stays live, the instance stays held, and
`workflows.state` is untouched. That is what lets the panel say "waiting on storage" rather than show a stalled
pause. The heartbeat continues throughout, so the reconciler treats a parked run as live (FR-048). Only if the
retry budget is
exhausted does the run fail — and it fails **naming the snapshot boundary it could not persist**, because that
is the difference between "your work is gone" and "your work is on an instance we are about to destroy".

**Rules.** Pause acknowledgement comes **after** step 3, so the working tree is captured before the user is told
the run is paused (FR-049, FR-050). Interruption is detected by polling instance metadata for the reclamation
notice — polling, not an event subscription, so detection lives in the process that owns the snapshot (R7). The
pause idle limit moves a paused workflow to `parked_resumable` with compute released — **not** failed (FR-050, US2 §4).

### Supervision commands — how a pause actually arrives

The executor polls `pullPendingCommands` on the same loop as corrections, applies each in `sequence` order, and
acknowledges. `pause` and `stop` enter `suspend()`; `resume` is handled by the control plane provisioning a fresh
instance from the snapshot, not by this executor.

**This is the path that makes the pause button work.** The panel writes a command row; nothing else on the
instance would ever observe it. The poll interval is bounded so worst-case latency — one interval plus quiesce to
a turn boundary plus snapshot — stays inside SC-003's 10 seconds, which also bounds how long a turn may run before
reaching a boundary. A command returned already `superseded` is acknowledged without being applied.

### Corrections

The executor polls `pullPendingCorrections`, delivers each via `sendTurn` in `sequence` order, and acknowledges
with the outcome (FR-049). A correction that cannot be delivered is acknowledged as `failed` with a reason —
never silently dropped. A correction arriving for a terminal workflow is rejected by the API before it reaches
the executor (FR-081).

## Snapshot and restore

**Snapshot** — one `tar.zst` of `/workspace`, containing every entry's working tree **and** `.git` (so
uncommitted work and index state survive) plus the agent's conversation state under `.agent-config`. Registered
with both state flags; a snapshot missing either is not resumable (FR-050).

**One exclusion: `/workspace/.agent-config/credentials/`.** FR-072 forbids a credential appearing in a snapshot
in plain text, so credential material is excluded from the tar. This costs nothing, because phases 2–5 run on
the restore boot as well — the bundle reinstalls the credentials it owns, which is why `setup.sh` idempotency
is a hard requirement rather than a nicety.

> **Amended by `003/FR-048` and `003/FR-050`.** The exclusion is unchanged and so is the reason for it. What
> changed is what re-supplies the excluded material on the way back in: the **agent's** credential is no
> longer installed by `setup.sh` at all, so the restore boot fetches it from the machine surface in bootstrap
> phase `credential_install` — which runs on _every_ boot, restore and resumed-instance alike. Every other
> credential under this path is still the bundle's, reinstalled exactly as described.

The config **directory** still lives inside
the pinned root, because conversation state must be captured (FR-051); it is the credential subtree, not the
config tree, that is excluded.

### Restore

1. Download and unpack the snapshot to `/workspace` — the same absolute path it was taken from.
2. Parse the conversation log line-by-line; **discard a trailing line that does not parse** and set
   `truncationRepaired` (FR-053). This is a normal path: the log is append-only and not written atomically.
3. Start the agent with `--resume` and the recorded session id.
   **Successor session identity.** A successor created by `continueWithChanges` (FR-150) inherits the predecessor's
   **snapshot** but is a distinct workflow with its own `session_id`. Restore therefore resumes under the
   **predecessor's** recorded session id — the id embedded in the snapshotted conversation state — while the
   successor's own `session_id` identifies the new run for addressing and future snapshots. The two are recorded
   separately (`session_id` and the snapshot's `sessionId`); conflating them makes `--resume` fail on the first
   successor, and it fails by finding nothing rather than by erroring.

4. Verify the working tree is present before reporting ready — conversation state without worktree state
   desynchronises the model's filesystem beliefs from reality (FR-050).

## Output pipeline

Applied to agent output **and** `setup.sh` output, in this order, **before** anything is persisted or
transmitted — so an unsanitised copy never exists at rest:

1. **Strip control sequences** — ANSI/VT escapes, spinner frames, cursor movement, carriage-return redraws
   (FR-045).
2. **Redact** — pattern matching plus known-value matching against every credential the bundle installed.
   Known-value matching is what catches a client credential in an unanticipated format (FR-045, FR-089).
3. **Segment** — chunk with a monotonic per-workflow sequence, write to S3, report via `appendLogSegment`
   (FR-046).

**Rules.** Segments are rate-limited and chunked rather than dropped; no output is lost on a high-volume run
(FR-047). Buffer locally and retry with backoff when the machine surface is unreachable, and flush everything to
durable storage before terminating for any reason (FR-047).

## Caps

The executor enforces `turnCap` and `spendCap` locally and stops at the next safe boundary, reporting
`capped` with consumption figures and preserving work in progress (FR-055). Where the bundle's
credential makes spend unmeasurable, the cap is advisory and the **bundle** declares it (FR-093) — the executor
still enforces the turn cap.

## Skills

Resolved from the **primary** workspace entry only; never searched for in other entries (FR-110). Each resolved
skill is reported via `reportSkillReference` with its **content digest**, so a run stays explicable after the
skills change (FR-059, SC-016) — a digest is the only version a repository file has. Reporting the resolution is
not optional bookkeeping: without it SC-016 cannot be satisfied at all. A missing, unreadable or
self-contradictory skill halts the workflow naming the skill and the step, with **no** guessed action on branches
or tickets (FR-058).

## Terminal reporting

The executor MUST NOT exit leaving the workflow `running` (FR-056). It calls `reportTerminal` with exactly one
outcome; the reconciler is the backstop for the case where the process dies before it can (FR-039).

## Explicitly not carried over from the POC

Reimplemented, not imported (FR-002); these are dropped entirely (FR-042):

- Alternative agent backends and executor routing
- Agent-to-agent and tool-server endpoints
- Inbound tunnels and in-worker webhook receipt
- Alternative auth modes and shared bearer tokens

Behaviour worth keeping and reimplementing: control-sequence stripping, process-group spawn with SIGKILL to the
group on timeout, and pushed-commit verification against the pre-execution remote SHA.
