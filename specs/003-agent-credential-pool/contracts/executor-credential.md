# Contract: Executor Credential Handling

**Feature**: `specs/003-agent-credential-pool` | **Date**: 2026-08-07

What changes in `apps/sisyphus-executor` and on the machine surface. Amends
[002's executor protocol](../../002-sisyphus-workflow-platform/contracts/executor-protocol.md).

## Bootstrap — one new phase

| #      | Phase                           | Change                                                              |
| ------ | ------------------------------- | ------------------------------------------------------------------- |
| 1–5    | `provisioning` … `setup_script` | Unchanged, except the bundle no longer installs an agent credential |
| **5a** | **`credential_install`**        | **New.** Fetch the leased material and install it for the agent     |
| 6      | `entry_checkout`                | Unchanged                                                           |
| 7      | `agent_start`                   | Unchanged                                                           |

**Position is deliberate.** After `setup_script`, because the bundle is what puts the agent CLI on the box.
Before `entry_checkout`, because there is no reason to clone repositories for a run that cannot authenticate.
Individually timed like every other phase, so a failure names `credential_install` rather than producing a
generic bootstrap failure (FR-049, FR-051).

**Runs on every boot** — first boot, restore boot, and resumed-instance boot (FR-050). It replaces the role
`setup_script` played in 002, where re-running the bundle was how a restored instance got its credentials back.

## Envelope

The job envelope gains **no credential material** (FR-012). It gains only what is needed to fetch it:

```
{
  ...existing 002 envelope...,
  agentCredential: { credentialId, leaseFence }
}
```

The envelope already carries `scopedCredential`, which is the instance's authority to call the machine surface.
That is what authorises the fetch. **Material in the envelope would put it in EC2 user-data**, which is readable
from the instance metadata service by anything running on the box — the reason FR-012 exists.

## Machine surface — two calls

### `fetchAgentCredential`

```
→ { workflowId }
← { material, credentialId, fence }
```

Authorised by the workflow's scoped credential. Returns material **only** for the credential the calling
workflow's live lease names — a workflow cannot fetch another's, and there is no parameter by which it could
try.

Fails if the workflow holds no live lease. That is a control-plane bug rather than a normal path, because
FR-016 guarantees the claim before the instance exists.

### `reportCredentialRotation`

```
→ { workflowId, fence, material }
← { accepted: boolean, reason?: 'stale_fence' | 'not_newer' }
```

**Rejected when `fence` is below the credential's current fence** (FR-020) — this is the whole fencing
mechanism, and the rejection is silent-but-recorded rather than fatal to the caller, because a rejected write
means the caller has already lost its claim and should not keep running.

Accepted **even when the workflow has already terminated**, provided the fence is current (FR-032). The
credential's future usability depends on the material, not on the run's state; a rotation arriving moments after
a workflow ends is still the newest material in existence.

## Rotation watch

```
on credential-file change:
  debounce
  read material
  reportCredentialRotation(workflowId, leaseFence, material)
```

**Rules.**

- **Flush on every suspend path.** `suspend()` is already the single routine for pause, stop and spot
  interruption, so one flush there covers all three. A rotation observed moments before a suspend must not be
  lost — this is the difference between a recoverable seat and one needing re-login.
- The watcher is written against **Linux** file behaviour. A developer machine may keep this material in an OS
  keychain instead, so local execution is not a valid test of this path (research R3).
- Material passes through the existing redaction pipeline as a known value (FR-014), so a rotation cannot reach
  a log even if something echoes it.

## Snapshot

**Unchanged from 002**: `/workspace/.agent-config/credentials/` stays excluded from the tar (FR-013,
preserving `002/FR-072`). What changes is only where the material comes from on the way back in — the lease,
not the bundle. The exclusion rule and its reasoning survive intact.

## Suspend — stop rather than hold

`002/FR-049` held the agent process alive on a running, billing instance. FR-039 replaces this with an instance
**stop** that preserves the disk.

| Purchase mode | Pause behaviour                                       | Resume                       |
| ------------- | ----------------------------------------------------- | ---------------------------- |
| `on_demand`   | Control-plane `StopInstances`; disk retained          | `StartInstances`, no restore |
| `spot`        | **Snapshot and terminate** — 002 behaviour, unchanged | Fresh instance from snapshot |

**Spot cannot be stopped.** A one-time spot instance supports only termination, and `spot` is the platform
default (`DEFAULT_PURCHASE_MODE`). Rather than change that cost decision here, spot pauses degrade to the
existing snapshot path — routed through the same fallback FR-043 already requires for "stopped instance will not
start again", so it is one code path rather than two (research R6).

**The stop is control-plane-initiated, never instance-initiated.** Instances launch with
`InstanceInitiatedShutdownBehavior: 'terminate'`, which exists so a crashed executor cannot leave a billable
stopped instance behind. That setting stays; the pause path calls `StopInstances` from the control plane
instead.

In both modes the credential lease is **retained** (FR-040, FR-019). Nothing about compute lifecycle touches it.

### Resume

For `on_demand`, resume is `StartInstances` on the same instance: the same session continues against the same
working tree, with no re-provision, no re-clone and no snapshot restore (FR-041). `credential_install` still
runs on this boot (FR-050) — the material may have rotated while the instance was stopped, and the copy on its
disk may be stale.

A paused workflow incurs storage cost but no compute cost, and this is surfaced rather than inferred (FR-042).

### Parking

Past the idle limit, the instance **and its disk** are released and the workflow becomes `parked_resumable`
(FR-044) — work survives in the durable snapshot. The credential lease is retained (FR-073), so a parked run
consumes a seat while consuming no compute. That is the trade the pool view's `parked` breakdown exists to make
visible (FR-074).

**One refusal**: if the durable snapshot is not resumable, parking must **not** release the instance or disk,
because they hold the only copy of the work. The condition is raised instead (FR-045). This inverts the normal
cost priority deliberately — an unresumable park is indistinguishable from data loss.

## What the setup bundle no longer does

`002/FR-043` and `002/FR-075` made `setup.sh` responsible for the agent CLI **and its credentials**. It keeps
the CLI, repository-host credentials, and third-party credentials. It installs no agent credential (FR-048), and
`spend_caps_enforceable` is unaffected.

Bundle **validation runs** remain possible without a credential (FR-052) — they run bootstrap phases 2–5 and
never reach `credential_install` or `agent_start`, so proving a bundle consumes no pool capacity.
