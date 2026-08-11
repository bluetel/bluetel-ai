# Contract: Allocation Protocol

> **DEPRECATED (2026-08-11):** The Sisyphus workflow platform — including the executor, control plane, admin app, and agent credential pool described in this document — has been deprecated in favour of the Claude Code GitHub Action. This was because the GitHub Action is easier to maintain and configure, and more customizable than the bespoke infrastructure it replaced. This document is retained as a historical design record only; the packages and apps it describes have been removed from the repository.

**Feature**: `specs/003-agent-credential-pool` | **Date**: 2026-08-07

How a workflow gets a credential, keeps it, and gives it back. Owned by
`apps/sisyphus-control-plane/src/credentials/`.

## The two moments

Acquisition is split across two points in time, and conflating them is the mistake this contract exists to
prevent.

| Moment      | Where         | When                                 | What                                                    |
| ----------- | ------------- | ------------------------------------ | ------------------------------------------------------- |
| **Reserve** | Control plane | At admission, **pre-provision**      | Claim a credential, or enter `awaiting_credential`      |
| **Fetch**   | Instance      | Bootstrap phase `credential_install` | Retrieve the material for an already-claimed credential |

**Reserving before provisioning is the whole point** (FR-016, FR-025). If a credential were claimed during
bootstrap, an instance would be launched and billed while sitting in a queue. By the time bootstrap runs, the
claim is guaranteed, so `credential_install` can fail only on transport — never on availability.

## Selection

```
selectFor(workflow):
  groups := attachments(workflow.executionProfile) ordered by position asc
  for group in groups:
    candidates := credentials where group_id = group.id
                    and state = 'available' and enabled and group.enabled
    if candidates non-empty:
      return least-recently-used by (last_used_at nulls first)
  return none
```

**Rules.**

- Candidates are drawn **only** from groups attached to the workflow's own execution profile (FR-063). There is
  no code path by which a credential outside those groups can be selected, which is what makes SC-016 an
  invariant of this function rather than something to audit for afterwards.
- Groups are tried **in order**; a lower-preference group is reached only when every earlier one has nothing
  available (FR-064). This is what expresses "my seats first, shared overflow second".
- LRU applies **within** the chosen group only (FR-034). It therefore does **not** keep the pool alive — a
  never-reached group would rot. That job belongs to keep-alive (FR-035), and this is the reason it exists.
- `last_used_at IS NULL` sorts first: a newly registered credential is the least recently used thing there is,
  and proving a fresh credential works early is worth more than spreading load.
- A profile with no attachments cannot reach this function — FR-065 refuses that configuration at save time, so
  it is not a runtime case.

## Acquire

One transaction, no exceptions:

```
BEGIN
  UPDATE agent_credentials
     SET state = 'held', fence = fence + 1, last_used_at = now()
   WHERE id = :selected AND state = 'available'          -- conditional: loser sees 0 rows
  IF 0 rows THEN ROLLBACK, re-select
  INSERT INTO credential_leases (agent_credential_id, workflow_id, fence, acquired_at)
  UPDATE workflows SET agent_credential_id = :selected, state = 'provisioning'
COMMIT
```

The conditional `WHERE state = 'available'` plus the partial unique index on live leases means two racing
acquisitions cannot both succeed — one commits, the other sees zero rows and re-selects. **Exclusivity is a
database guarantee here, not an application one** (FR-017, SC-003).

`fence` increments on acquisition and is carried on the lease. See [fencing](#fencing).

## Release

Released **only** on terminal state or admin force-release (FR-019). Not on pause. Not on park. Not when an
execution environment is destroyed.

```
BEGIN
  UPDATE credential_leases SET released_at = now(), release_reason = :reason
   WHERE workflow_id = :workflow AND released_at IS NULL
  UPDATE agent_credentials SET state = 'available' WHERE id = :credential AND state = 'held'
COMMIT
```

A credential that was `cooling_off` or `unhealthy` while held returns to that state, not to `available` — the
release does not repair it.

## Granting to waiters

On every release, and on every credential returning from `cooling_off`:

```
grant(credential):
  waiter := workflows in 'awaiting_credential'
              where credential.group ∈ attachments(workflow.executionProfile)
              order by created_at asc
              limit 1
  if waiter: acquire(waiter, credential)
```

**Ordered among reachable waiters only** (FR-026). A workflow whose profile cannot reach this credential's group
is skipped rather than blocking the queue behind it — which is what makes FR-068 and SC-017 true: saturating one
group does not stall profiles attached elsewhere.

## Fencing

| Step | Rule                                                                                   |
| ---- | -------------------------------------------------------------------------------------- |
| 1    | `fence` increments on the credential at each acquisition                               |
| 2    | The lease records the value it was issued                                              |
| 3    | The instance presents its lease's fence on every rotation write                        |
| 4    | The machine surface **rejects any write whose fence < the credential's current fence** |

This is what stops a partitioned-but-alive former holder overwriting newer material with its stale copy
(FR-020, FR-031). Lease expiry alone cannot do it: a partitioned holder does not know it lost, and will keep
writing. The fence makes its writes rejectable without anyone having to determine whether it is dead.

Because releases are rare under FR-019, the fence rarely advances — it exists for the force-release and
reconciliation paths, which are precisely where a previous holder may still be running.

## Reconciliation

The existing FR-039 sweep gains one direction: a live lease whose workflow is terminal, absent, or has been
terminal beyond one sweep interval is released with `release_reason = 'forced'` and the reason recorded
(FR-022, SC-015).

It does **not** release leases held by `paused` or `parked_resumable` workflows. Those are live claims by
design, and reclaiming them is the bug this sentence exists to prevent.

## Failure paths

| Condition                                        | Behaviour                                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Reserved, then provisioning fails                | Lease released, reason recorded (FR-021)                                                            |
| Waiting workflow cancelled by its owner          | Terminates having **never provisioned an instance**; it held no lease, so none is released (FR-027) |
| Waiting beyond the configured limit              | Workflow fails naming credential exhaustion; wait duration recorded (FR-028)                        |
| Held credential enters `cooling_off`             | Run waits; **lease retained**; owner sees a provider limit, not a stall (FR-077)                    |
| Held credential enters `unhealthy`               | Run fails naming the credential; no substitution (FR-023); lease releases as terminal               |
| Every reachable credential unhealthy or disabled | Reported as such, distinctly from "all held" (FR-029)                                               |
| Reachable groups contain no credentials at all   | Reported as a configuration fault, not a wait (FR-029)                                              |
