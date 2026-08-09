# Feature Specification: Agent Credential Pool

**Feature Branch**: `feature/sisyphus`

**Created**: 2026-08-07

**Status**: Draft

**Input**: User description: "Bundles are shared, but the agent's OAuth credential mutates during a run, so it
cannot be carried inside one. Introduce a pooled agent credential — a single login session that is leased into an
ephemeral execution environment, mutated there, and returned to the pool — and keep the session on the instance
across a pause."

**Supersedes**: parts of `specs/002-sisyphus-workflow-platform`. See
[Relationship to 002](#relationship-to-002).

> **Requirement numbering.** `FR-nnn` and `SC-nnn` in this document refer to **this** specification.
> Requirements belonging to the platform specification are always cited as `002/FR-nnn`.

---

## Why this exists

002 assumes the agent's credential is a static secret: the setup bundle installs it, snapshots exclude it, and
every boot reinstalls it from the bundle (`002/FR-072`, and the exclusion rule in the executor protocol —
"this costs nothing, because phases 2–5 run on the restore boot as well").

That assumption holds for a metered API key. It is **false for a subscription login session**, whose refresh
credential rotates each time the agent uses it. A bundle-carried copy is stale the moment the agent refreshes,
so reinstalling it either presents a revoked credential or forces a fresh login. Bundles are also shared across
clients, which makes "bake the credential into the bundle" wrong on two counts at once: it is stale, and it is
shared.

Rotation also imposes a constraint that no amount of care at the bundle layer can remove: **if two live sessions
share one login, a refresh by either invalidates the other.** Exclusive use is therefore a property the platform
must guarantee, not a convention it can hope for.

This specification separates _what machine setup a client needs_ (the setup bundle, unchanged) from _which agent
identity performs the work_ (a new pooled entity), and makes exclusive use of that identity a leased,
observable, auditable thing.

## Clarifications

- Q: Two concepts could own the agent identity — the setup bundle that installs it, or a separate entity. Which?
  → A: A **separate entity**. The bundle keeps repository-host and third-party credentials; the agent credential
  moves out entirely. The two vary independently — three bundles and four credentials should be seven objects,
  not twelve.
- Q: Should the entity be named for the agent vendor (e.g. "Claude provider")? → A: **No.** 002 keeps the agent
  backend swappable behind an adapter boundary; naming the vendor into the data model spends that for nothing.
  The entity is an **agent credential**; a single one is colloquially a **seat**.
- Q: How is exclusive use guaranteed — pin each credential to a long-lived machine, or lease it to ephemeral
  ones? → A: **Lease it.** Pinning would collapse concurrency to one run per configuration and reintroduce
  machine state drift; leasing bounds concurrency by the number of seats instead, across any configuration,
  and leaves execution environments ephemeral and reproducible.
- Q: Does a paused workflow keep its seat, or release it? → A: **Keeps it**, for the general reason that a
  workflow keeps its seat until it terminates (see the entire-lifetime clarification below). Two supporting
  facts for the pause case specifically: the session stays on its stopped instance, so the credential material
  is on that disk and could not be lent elsewhere anyway; and releasing would move a workflow between agent
  identities mid-run. Capacity is answered by holding more seats, not by reclaiming held ones.
- Q: If a seat is only used when a workflow demands it, seats can expire from disuse. How is that prevented?
  → A: Two mechanisms. Selection is **least-recently-used**, which rotates use across the pool by construction;
  and a **scheduled keep-alive** exercises any seat idle beyond a threshold regardless of demand. LRU reduces
  how often keep-alive must fire; it does not replace it.
- Q: Where is a seat acquired — at admission or during instance bootstrap? → A: **Reserved at admission**,
  before any compute is provisioned; **fetched** during bootstrap. Acquiring during bootstrap would leave a
  billing instance idle in a queue.
- Q: Can any workflow use any seat, or is the pool partitioned? → A: **Partitioned by named groups, attached to
  execution profiles.** A credential belongs to exactly one **credential group**; an execution profile is
  attached to one or more groups in preference order; a workflow draws from the union of its profile's groups,
  trying each in turn. Strict single membership is what keeps "how much capacity does this group have" a
  well-defined number, which the queue view depends on; sharing is expressed by attaching one group to several
  profiles, not by a credential joining several groups.
- Q: Does preference ordering starve a lower-preference group, whose credentials then expire from disuse?
  → A: No, and this is why scheduled keep-alive is not merely an optimisation. Least-recently-used selection
  only rotates use _within_ the group being drawn from, so an overflow group attached to a quiet profile could
  go untouched indefinitely. Keep-alive runs on demand-independent schedule and is what actually guarantees
  liveness under partitioning.
- Q: The pooled entity is a login session — should it be called a "session"? → A: **No**, for the same reason
  the vendor name was rejected. 002 already uses _session_ for the agent's conversation (`session_id`,
  `session_snapshots`, `--resume`), which is an unrelated concept that would now collide in the same codebase.
  The entity stays **agent credential** in the model; "session" remains available as user-facing wording.

### Session 2026-08-07

- Q: Where does an administrator perform an agent credential's login, and how does the resulting material reach
  the secret store? → A: In a **platform-hosted ephemeral login environment**. The platform provisions a
  short-lived, isolated environment, the administrator drives the agent's own login flow inside it through a
  relayed session, and the material is captured server-side directly into the secret store. Material never
  transits an administrator's device, and re-login is the identical flow.
- Q: When a parked workflow resumes, must it reacquire the credential it had before? → A: **The question does
  not arise: one workflow uses one credential for its entire life and never gives it up until it terminates.**
  A pause keeps it, and so does a park — an execution environment being destroyed is not the workflow ending.
  Environments come and go; the claim does not move. This makes single-identity attribution absolute rather
  than best-effort, and it removes the reacquire-on-resume path entirely.
- Q: Should a metered API key, which does not rotate and could safely serve many workflows at once, be modelled
  as non-exclusive? → A: **No — every credential is exclusive, including API keys.** An exclusivity flag would
  branch selection, keep-alive, queueing and capacity accounting for the sake of one credential kind. One rule
  with no exemptions is worth more than the concurrency it gives up: a key that could serve many runs serves
  one, and additional concurrency is bought by registering it as additional credentials. This also removes the
  mixed-group problem entirely — an always-available credential can no longer starve the seats beside it.
- Q: A credential that has hit a provider usage or rate limit is not broken, just busy. Is that the same as
  unhealthy? → A: **No — it is a distinct, self-clearing `cooling off` state.** Unhealthy means broken and
  needing an administrator; cooling off means temporarily unavailable and returning on its own. Conflating them
  would page a human for something that fixes itself, and would steadily drain a busy pool into a pile of false
  outages. A workflow whose own credential cools off mid-run waits it out rather than failing, because FR-023
  forbids substituting another.
- Q: Should a workflow's owner be actively notified when their run waits for a seat, cools off mid-run, or
  parks? → A: **No — these states are visible in the workflow view and nothing is pushed.** Waiting and cooling
  off usually resolve in seconds without anyone needing to act, and notifying on them would train people to
  ignore the channel. Administrator alerting is unaffected: pool health, expiry and over-long holds are still
  pushed (FR-056), because those do need a human. Engineer-facing notification stays a deliberate non-goal.
- Q: If a parked workflow never releases its credential, what stops an abandoned one from holding a seat
  forever? → A: Three existing bounds, no new mechanism. A parked workflow becomes terminal when its durable
  snapshot passes the platform's retention period and it is no longer resumable, which releases the credential;
  a lease held beyond a configurable expectation is flagged to administrators; and an administrator can force
  release. Capacity pressure from held seats is answered by holding more seats, consistent with the pause
  decision above.

---

## Relationship to 002

This specification **changes** the following, which the platform specification states otherwise:

| 002 requirement                 | Was                                                       | Becomes                                                                                                  |
| ------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `002/FR-043`, `002/FR-075`      | `setup.sh` installs the agent CLI **and its credentials** | Installs the agent CLI and non-agent credentials only; agent credential is leased                        |
| `002/FR-072`                    | Credentials reinstalled from the bundle on every boot     | Agent credential fetched from its lease on every boot                                                    |
| `002/FR-049`                    | Pause holds the agent process alive on a running instance | Pause stops the instance (on-demand); session persists on its disk. Spot degrades to 002's snapshot path |
| `002/US2 §4` (pause idle limit) | Paused too long → snapshot, release instance              | Unchanged; the seat is **retained**, since parking is not the workflow ending                            |

Execution profiles are **extended**, not changed: they gain an ordered attachment to credential groups
(FR-062), and everything else about them — versioning, access control, locked fields — is untouched.

This specification **leaves intact**: access control and execution profiles, workspaces and entries,
integrations and scheduling, the correction and supervision paths, the output strip-and-redact pipeline,
notifications, snapshots as a durability mechanism, and the reconciliation sweep. Snapshots stop being the
_resume_ path for a pause and remain the durability and recovery path.

---

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Register an agent credential and complete its login (Priority: P1)

An administrator adds a seat to the pool: names it, records which agent identity it represents, and completes
the interactive login **once**. The seat becomes available to the pool only after a successful login is proven,
so an unusable seat never reaches a workflow.

**Why this priority**: The pool is empty until this exists, and every other story depends on at least one
usable seat. It is also the only step that requires a human, so it must be the least surprising part of the
system.

**Independent Test**: Register a seat, complete the login, and observe it reported as available with a recorded
login time — with no workflow involved at any point.

**Acceptance Scenarios**:

1. **Given** no seats exist, **When** an administrator registers one and completes its login, **Then** the seat
   is available to the pool and its login time is recorded.
2. **Given** a seat registration whose login was started but not completed, **When** the pool is queried,
   **Then** the seat is reported as awaiting login and is never selected for a workflow.
3. **Given** a login attempt that fails, **When** the administrator views the seat, **Then** the failure and its
   reason are shown against the seat, and the seat remains unavailable.
4. **Given** a registered seat, **When** any non-administrator attempts to register, re-login or delete a seat,
   **Then** the action is refused and recorded.
5. **Given** a login that completes, fails or is abandoned, **When** it ends, **Then** the login environment is
   destroyed, and at no point was credential material shown to or downloadable by the administrator.

---

### User Story 2 - Group credentials and scope them to execution profiles (Priority: P1)

An administrator collects agent credentials into named **credential groups**, and attaches one or more groups to
an execution profile in preference order. A workflow launched under that profile draws only from the credentials
in those groups, trying each group in turn. This is how a client's work is kept to that client's own agent
identities, while still allowing a shared overflow group to absorb spikes.

**Why this priority**: A credential belongs to exactly one group and a profile is unlaunchable without one, so
grouping is on the path of every run, not an optional refinement. It is also the only mechanism that keeps one
client's work from being performed under another client's agent identity.

**Independent Test**: Create two groups with distinct credentials, attach one to a profile, launch under that
profile repeatedly, and confirm no credential from the unattached group is ever used.

**Acceptance Scenarios**:

1. **Given** an administrator creating a credential, **When** it is registered, **Then** it is placed in exactly
   one credential group.
2. **Given** an execution profile with a group attached, **When** a workflow is launched under it, **Then** the
   credential selected belongs to that group.
3. **Given** an execution profile with two groups attached in preference order, **When** a workflow is launched
   and the first group has an available credential, **Then** that group is used; **and when** the first group is
   fully held, **Then** the second group is used.
4. **Given** an execution profile with no group attached, **When** an administrator attempts to save it,
   **Then** the profile is refused as unlaunchable, naming the missing attachment — rather than failing later at
   launch.
5. **Given** two profiles attached to disjoint groups, **When** every credential in one group is held, **Then**
   workflows under the other profile are unaffected and do not wait.
6. **Given** a credential group attached to any profile or holding any credential, **When** deletion is
   attempted, **Then** it is refused in favour of disabling.
7. **Given** any change to group membership or to a profile's group attachments, **When** it is made, **Then**
   it is recorded with the acting administrator.
8. **Given** a non-administrator, **When** they attempt to create a group or change an attachment, **Then** the
   action is refused and recorded.

---

### User Story 3 - A workflow leases a seat for its lifetime (Priority: P1)

A workflow reserves exactly one seat when it is admitted, uses it for the whole run, has every credential
rotation persisted centrally as it happens, and releases the seat when it reaches a terminal state. No other
workflow can hold that seat in the meantime.

**Why this priority**: This is the mechanism the whole specification exists to provide. Without it, runs either
share a login and destroy each other's credential, or carry a stale one and fail to start.

**Independent Test**: Start one workflow, observe a seat move to held with that workflow named against it,
observe the agent authenticate on the instance, and observe the seat released on completion.

**Acceptance Scenarios**:

1. **Given** an available seat, **When** a workflow is admitted, **Then** the seat is reserved to that workflow
   before any compute is provisioned.
2. **Given** a workflow holding a seat, **When** a second workflow is admitted, **Then** the second workflow is
   never given the same seat.
3. **Given** a running workflow whose agent rotates its credential, **When** the rotation occurs, **Then** the
   new credential is persisted centrally without waiting for the run to end.
4. **Given** a workflow that reaches any terminal state, **When** it terminates, **Then** its seat is released
   and becomes selectable again.
5. **Given** a workflow whose instance is lost without warning, **When** the reconciliation sweep runs, **Then**
   the workflow's fate is resolved and its seat is released with the reason recorded.
6. **Given** an instance that has lost its lease but is still running, **When** it attempts to persist a
   credential rotation, **Then** the attempt is rejected rather than overwriting a newer credential.

---

### User Story 4 - A workflow waits for a seat instead of burning compute (Priority: P1)

Every seat is held. A newly admitted workflow enters a distinct, visible waiting state, holds no instance, and
starts as soon as a seat frees. The engineer is told it is waiting for a seat rather than left watching an
unexplained delay.

**Why this priority**: Pool exhaustion is the normal steady state of a well-utilised pool, not an error. If it
is invisible or expensive it will be discovered as a mysterious stall and a surprising bill.

**Independent Test**: Hold every seat, admit one more workflow, and confirm it reports waiting-for-seat, has no
instance provisioned against it, and starts automatically when a seat is released.

**Acceptance Scenarios**:

1. **Given** a fully leased pool, **When** a workflow is admitted, **Then** it enters the waiting state and no
   compute is provisioned for it.
2. **Given** a workflow waiting for a seat, **When** a seat is released, **Then** exactly one waiting workflow
   is given it, in admission order.
3. **Given** a workflow waiting for a seat, **When** an engineer views it, **Then** it is shown as waiting for a
   seat, with how long it has been waiting.
4. **Given** a workflow waiting for a seat, **When** the engineer cancels it, **Then** it terminates without
   ever having provisioned an instance.
5. **Given** a workflow that has waited beyond the configured limit, **When** the limit is reached, **Then** the
   workflow fails naming seat exhaustion as the cause, and the wait is recorded.

---

### User Story 5 - Pause keeps the session on its instance (Priority: P2)

An engineer pauses a run. The agent finishes its turn, the instance is stopped rather than destroyed, and the
workspace, conversation state and credential stay on its disk. Resuming starts the same instance again — no
re-provision, no re-clone, no restore.

**Why this priority**: This is what makes pause cheap enough to use freely, and it is why a paused workflow can
hold a seat safely: the credential is on that instance's disk and could not be lent elsewhere regardless.

**Independent Test**: Pause a run, confirm the instance is stopped and no longer billing for compute, resume,
and confirm the agent continues the same conversation against the same working tree.

**Acceptance Scenarios**:

1. **Given** a running workflow, **When** it is paused, **Then** the agent reaches a turn boundary, a snapshot
   is captured for durability, and the instance is stopped.
2. **Given** a paused workflow, **When** the engineer resumes it, **Then** the same instance is started and the
   run continues the same conversation with the same working tree, including uncommitted work.
3. **Given** a paused workflow, **When** the pool is queried, **Then** its seat is still shown as held by that
   workflow.
4. **Given** a paused workflow, **When** costs are reported, **Then** it is shown as incurring storage cost but
   no compute cost.
5. **Given** a paused workflow whose stopped instance cannot be started again, **When** resume is attempted,
   **Then** the run is recovered from its snapshot onto a new instance using the same seat, and the substitution
   is recorded.

---

### User Story 6 - A long-paused workflow parks and gives its compute back (Priority: P2)

A workflow left paused past the idle limit is parked: its work is preserved durably and its stopped instance and
disk are released, so it stops costing anything to keep. It keeps its seat, because it is not over. Resuming it
provisions a fresh instance and continues under the same agent identity it started with.

**Why this priority**: Without it, one forgotten pause holds a disk and an instance indefinitely. Parking
reclaims everything that costs money per hour, while leaving the one thing that must not change — the workflow's
agent identity — exactly where it was.

**Independent Test**: Pause a run, advance past the idle limit, and confirm the workflow is parked-resumable,
its instance and disk are gone, its seat is still held by it, and it resumes correctly under the same
credential.

**Acceptance Scenarios**:

1. **Given** a paused workflow, **When** the idle limit passes, **Then** it is marked parked-resumable, its
   instance and disk are released, and the engineer is told it was parked rather than failed.
2. **Given** a parked workflow, **When** the pool is queried, **Then** its seat is still shown as held by it,
   and distinguishable from a seat held by a running or paused workflow.
3. **Given** a parked workflow, **When** the engineer resumes it, **Then** a fresh instance is provisioned, the
   run resumes from its snapshot under the credential it already holds, and it never waits for a seat.
4. **Given** a paused workflow approaching the idle limit, **When** the engineer views it, **Then** the time
   remaining before it parks is shown.
5. **Given** a paused workflow whose durable snapshot is not resumable, **When** the idle limit passes, **Then**
   the instance is **not** released and the condition is raised, because releasing it would destroy the only
   copy of the work.
6. **Given** a parked workflow whose snapshot passes the retention period, **When** it ceases to be resumable,
   **Then** it becomes terminal and its seat is released.

---

### User Story 7 - Seats stay alive without being used (Priority: P2)

Seats do not silently expire from disuse. Selection favours the least recently used seat so demand spreads
across the pool, and a scheduled process exercises any seat that has been idle too long regardless of whether
any workflow needs it.

**Why this priority**: An expired seat fails at the worst possible moment — when a workflow finally selects it —
and recovery requires a human. This converts an unpredictable human interruption into a background task.

**Independent Test**: With no workflows running, advance past the idle threshold and confirm every seat has been
exercised and its liveness time updated.

**Acceptance Scenarios**:

1. **Given** several available seats, **When** a workflow reserves one, **Then** the least recently used
   available seat is selected.
2. **Given** a seat idle beyond the threshold, **When** the scheduled keep-alive runs, **Then** the seat is
   exercised and its liveness time updated, with no workflow involved.
3. **Given** a seat whose keep-alive fails, **When** the failure occurs, **Then** the seat is marked unhealthy,
   excluded from selection, and raised to administrators.
4. **Given** a seat currently held by a workflow, **When** the keep-alive runs, **Then** that seat is skipped
   rather than exercised concurrently with its holder.

---

### User Story 8 - An administrator can see and steer the pool (Priority: P2)

An administrator opens a pool view showing every seat, its health, who holds it and for how long, when it was
last used and last kept alive, how close it is to expiry, and what it has consumed — alongside the queue of
workflows waiting for a seat.

**Why this priority**: The pool is a scarce, individually-failable, silently-expiring resource, and the decision
this specification defers to operators — "hold more seats" — cannot be made without seeing the queue.

**Independent Test**: With seats in mixed states and at least one workflow waiting, open the pool view and
confirm every state is distinguishable and the queue depth and wait times are shown.

**Acceptance Scenarios**:

1. **Given** a pool in mixed states, **When** an administrator opens the pool view, **Then** each seat's state,
   holder, hold duration, last-used time, liveness time and health are shown.
2. **Given** workflows waiting for a seat, **When** an administrator opens the pool view, **Then** the queue
   depth and the longest current wait are shown.
3. **Given** a seat approaching expiry or already unhealthy, **When** the condition arises, **Then**
   administrators are alerted without having to be looking at the view.
4. **Given** a seat held longer than the configured expectation, **When** the threshold passes, **Then** it is
   flagged, naming the holding workflow.
5. **Given** any consumption recorded against a workflow, **When** an administrator views the pool, **Then**
   consumption is also attributable per seat.
6. **Given** a non-administrator, **When** they attempt to open the pool view, **Then** access is refused.

---

### User Story 9 - An administrator recovers a broken seat (Priority: P3)

A seat whose login has broken can be taken out of service, forced free of a stuck lease, re-logged-in, and
returned to the pool — without touching any setup bundle and without disturbing runs on other seats.

**Why this priority**: Logins break eventually. Recovery must not require re-uploading a bundle or restarting
the platform, and it must be attributable.

**Independent Test**: Break a seat's login, confirm it is marked unhealthy and excluded from selection,
re-login, and confirm it returns to the pool.

**Acceptance Scenarios**:

1. **Given** a seat whose login has broken, **When** a workflow attempts to use it, **Then** the workflow fails
   naming the seat, the seat is marked unhealthy and excluded, and the failure is not silently retried on a
   different seat mid-run.
2. **Given** an unhealthy seat, **When** an administrator completes a fresh login, **Then** it returns to the
   pool and the re-login is recorded against the acting administrator.
3. **Given** a seat held by a lease that will never be released, **When** an administrator forces its release,
   **Then** the seat returns to the pool, the affected workflow is resolved to a recorded state, and the forced
   release is attributed.
4. **Given** an administrator disables a seat, **When** it is currently held, **Then** the holding run is
   allowed to finish and the seat is withheld from future selection rather than pulled mid-run.
5. **Given** a seat that has never been used by any workflow, **When** an administrator deletes it, **Then** it
   is removed; **and given** a seat that has been used, **When** deletion is attempted, **Then** it is refused
   in favour of disabling, so historical attribution survives.

---

### Edge Cases

- **Two instances believe they hold the same seat** (the earlier one partitioned rather than dead). The later
  holder wins; the earlier one's attempt to persist a rotation is rejected, so a stale credential can never
  overwrite a newer one.
- **The instance dies between the agent rotating its credential and that rotation being persisted.** The seat
  may be left holding a superseded credential. It must be detectable as unhealthy on next use rather than
  handed out repeatedly to fail, and recoverable by re-login.
- **A seat is released while a workflow is waiting, and that workflow is cancelled in the same moment.** The
  seat must not be lost to a workflow that no longer exists, nor granted twice.
- **The pool is empty because every seat is unhealthy or cooling off**, not because every seat is held. Waiting
  workflows must be told which — waiting on capacity is patience, waiting on a provider limit is patience with a
  known end, and waiting on breakage is an outage.
- **Every seat is held by paused or parked workflows.** Running work cannot start at all, and a parked holder
  shows no activity while consuming capacity indefinitely — so the pool looks idle and behaves as though it is
  full. This is the condition the held-too-long flag and the running/paused/parked breakdown exist to surface
  before a blocked engineer discovers it.
- **An instance is stopped for pause and cannot be started again** (capacity, zone, or disk failure). The run
  must recover from its durable snapshot rather than be lost, since pause is not permitted to be the operation
  that loses work.
- **A workflow is admitted, reserves a seat, and then fails to provision an instance.** The seat must be
  returned rather than stranded by a failure that happened after reservation.
- **A credential rotation arrives for a workflow that has already terminated.** It must still be persisted if it
  is newer, because the seat's usability depends on it, not on the workflow's state.
- **The keep-alive schedule and a workflow reservation select the same idle seat simultaneously.** One must
  lose; the seat must never be exercised concurrently by two parties.
- **A seat is disabled while workflows are waiting for a seat.** The queue must not wait on capacity that will
  never arrive.
- **An administrator abandons a login part-way** — closes the relayed session without completing or failing it.
  The login environment must still be reaped rather than left running, and the credential must remain
  unselectable.
- **A credential is moved between groups while it is held.** The move must not retarget a live run, and it must
  not make the holding workflow unreachable by its own release path.
- **A group is detached from a profile while a workflow launched under that profile still holds one of its
  credentials.** The run must continue; the detachment governs future selection only.
- **Every credential in a profile's first-preference group is unhealthy while the second group is free.**
  Selection must fall through rather than wait, since the first group has no capacity to offer.
- **A profile's attached groups collectively contain no credentials at all** — every group is empty or newly
  created. This is indistinguishable to an engineer from a busy pool unless reported as a configuration fault
  rather than a wait.

---

## Requirements _(mandatory)_

### Functional Requirements

#### Agent credential identity and lifecycle

- **FR-001**: The platform MUST represent an agent credential as a first-class entity, distinct from the setup
  bundle, with its own identity, name and lifecycle.
- **FR-002**: Every agent credential MUST be exclusive — at most one live holder at a time — with no exemption
  for credential kinds that could technically tolerate concurrent use.
- **FR-003**: The platform MUST NOT name a specific agent vendor in the credential entity; the agent backend
  MUST remain swappable behind the existing adapter boundary.
- **FR-004**: Registering, editing, re-logging-in, disabling and deleting an agent credential MUST require the
  administrator role, and every such action MUST be recorded with the acting administrator.
- **FR-005**: An agent credential that has been used by any workflow MUST NOT be deletable; it MUST be
  disableable instead, so historical attribution survives.
- **FR-006**: Disabling an agent credential MUST withhold it from future selection without interrupting a run
  currently holding it.

#### Credential groups and profile scoping

- **FR-060**: The platform MUST represent a **credential group** as a named, administrator-managed collection of
  agent credentials.
- **FR-061**: Every agent credential MUST belong to **exactly one** credential group, assigned at registration.
- **FR-062**: An execution profile MUST be attachable to one or more credential groups, in an explicit
  preference order.
- **FR-063**: A workflow MUST only ever be granted a credential belonging to a group attached to its execution
  profile.
- **FR-064**: Credential selection MUST take the first attached group, in preference order, that has an
  available credential, and select least-recently-used within that group.
- **FR-065**: An execution profile with no attached credential group MUST be refused at configuration time as
  unlaunchable, naming the missing attachment, rather than failing at launch.
- **FR-066**: A credential group that is attached to any execution profile or contains any agent credential MUST
  NOT be deletable; it MUST be disableable instead.
- **FR-067**: Creating, renaming, disabling or deleting a credential group, changing its membership, and
  changing a profile's group attachments MUST require the administrator role and MUST be recorded with the
  acting administrator.
- **FR-068**: Credential exhaustion MUST be evaluated per execution profile against its attached groups only, so
  a profile whose groups have capacity is never made to wait by an unrelated profile's demand.

#### Login and re-login

- **FR-007**: The platform MUST provide an administrator-driven login flow that establishes an agent
  credential's session once, without embedding credential material in any setup bundle.
- **FR-069**: The login flow MUST run inside a platform-provisioned, short-lived environment that is isolated
  from workflow execution and holds no workspace, and the administrator MUST drive the agent's own login inside
  it through a relayed session.
- **FR-070**: Resulting credential material MUST be captured server-side directly into the secret store. It MUST
  NOT be transmitted to, displayed to, downloaded by, or pasted by the administrator at any point.
- **FR-071**: The login environment MUST be destroyed once material is captured, once the attempt fails, or once
  the attempt is abandoned, and MUST NOT be reachable by any workflow while it exists.
- **FR-072**: Re-login (FR-010) MUST use the same flow as first login, so returning a broken credential to
  service is not a different or lesser-tested path.
- **FR-008**: An agent credential MUST NOT become selectable until a login has been proven successful.
- **FR-009**: A failed or incomplete login MUST leave the credential unselectable, with the reason visible
  against it.
- **FR-010**: The platform MUST allow re-login on an existing agent credential, returning it to service without
  requiring any setup bundle to be re-registered.

#### Credential material handling

- **FR-011**: Agent credential material MUST be held in a dedicated secret store, never in the platform
  database and never inside a setup bundle archive.
- **FR-012**: Agent credential material MUST NOT appear in the job envelope handed to an instance; the instance
  MUST fetch it using its existing workflow-scoped credential.
- **FR-013**: Agent credential material MUST remain excluded from session snapshots, preserving `002/FR-072`.
- **FR-014**: Agent credential material MUST pass through the existing output redaction pipeline as a known
  value, so it cannot reach a log.

#### Leasing

- **FR-015**: A workflow MUST hold exactly one agent credential for its entire lifetime, from admission until it
  reaches a terminal state, and MUST NOT change credential at any point in between.
- **FR-016**: A lease MUST be reserved at workflow admission, **before** any compute is provisioned.
- **FR-017**: An agent credential MUST NOT be leased to more than one live workflow at a time.
- **FR-018**: A lease MUST belong to the workflow, not to an execution environment; an environment borrows its
  workflow's lease for the environment's lifetime. Environments being provisioned, stopped, destroyed and
  rebuilt MUST NOT affect the lease.
- **FR-019**: A lease MUST be released **only** when its workflow reaches a terminal state, or when an
  administrator forces its release. Pausing, parking, and the destruction of an execution environment MUST NOT
  release it.
- **FR-020**: A lease MUST carry a monotonically increasing fencing value, and any attempt to persist credential
  material under a superseded fencing value MUST be rejected.
- **FR-021**: A workflow that reserves a lease and then fails before running MUST have its lease released with
  the reason recorded.
- **FR-022**: The reconciliation sweep MUST resolve leases whose workflow no longer exists or whose fate is
  already decided, so no seat is stranded.
- **FR-023**: A workflow MUST NOT be moved to a different agent credential under any circumstance — not across a
  pause, a park, an environment rebuild, or a credential failure. A credential failure MUST fail the run naming
  the credential rather than substituting another.
- **FR-073**: A parked workflow MUST retain its agent credential, and MUST release it when it becomes terminal —
  including when it becomes terminal by its durable snapshot passing the retention period and ceasing to be
  resumable.

#### Waiting for a seat

- **FR-024**: A workflow admitted when no agent credential **in its execution profile's attached groups** is
  available MUST enter a distinct waiting state, reported as waiting for an agent credential.
- **FR-025**: A waiting workflow MUST NOT have compute provisioned for it.
- **FR-026**: A released credential MUST be granted, in admission order, to the longest-waiting workflow **that
  can reach it** — that is, whose execution profile is attached to that credential's group — one workflow per
  release.
- **FR-027**: A waiting workflow MUST be cancellable, terminating without ever provisioning an instance.
- **FR-028**: A workflow waiting beyond a configurable limit MUST fail naming credential exhaustion, with the
  wait duration recorded.
- **FR-029**: The platform MUST report which of these applies when a workflow waits, and name the attached
  groups that were searched, because the remedy differs in each case: all reachable credentials are **held**
  (add capacity, or wait), all are **cooling off** (wait; it clears itself), all are **unhealthy or disabled**
  (an administrator must act), or the groups contain **no credentials at all** (a configuration fault, not a
  wait).

#### Rotation and durability

- **FR-030**: Credential rotations occurring during a run MUST be persisted centrally as they occur, not
  deferred to the end of the run.
- **FR-031**: A persisted rotation MUST replace the stored material only when it is newer than what is stored,
  under the lease's fencing value.
- **FR-032**: A rotation persisted after its workflow has terminated MUST still be stored if it is newer, since
  the credential's future usability depends on it.
- **FR-033**: An agent credential whose stored material is detected as no longer usable MUST be marked
  **unhealthy** and excluded from selection rather than repeatedly issued.
- **FR-075**: The platform MUST distinguish **unhealthy** (broken; requires an administrator) from **cooling
  off** (temporarily unavailable because of a provider usage or rate limit; clears without human action), and
  MUST NOT treat a provider limit as a breakage.
- **FR-076**: A cooling-off credential MUST be skipped by selection and MUST return to selection automatically
  when its limit clears, with no administrator action and no alert raised.
- **FR-077**: A workflow whose own credential enters cooling off mid-run MUST wait for it to clear rather than
  fail, because FR-023 forbids substituting another credential. The wait MUST be visible to the workflow's owner
  as a provider limit rather than presented as a stall.
- **FR-078**: Where the provider indicates when a limit will clear, the pool view MUST show the expected return
  time; where it does not, the credential MUST still be retried rather than left cooling off indefinitely.
- **FR-079**: Waiting for a credential, cooling off, and parking MUST NOT raise a notification to the workflow's
  owner. They are reported in the workflow view only. Administrator alerting under FR-056 is unaffected.

#### Liveness

- **FR-034**: Selection among available credentials **within the group being drawn from** MUST prefer
  the least recently used.
- **FR-035**: The platform MUST exercise any credential idle beyond a configurable threshold on a
  schedule, independently of workflow demand and **independently of which group it belongs to**, and record the
  time it was last exercised. Preference ordering means a lower-preference group may receive no traffic for long
  periods, so this schedule — not least-recently-used selection — is what guarantees liveness.
- **FR-036**: Keep-alive MUST skip credentials that are currently leased or disabled.
- **FR-037**: A keep-alive that fails because the credential is broken MUST mark it unhealthy, exclude it from
  selection, and raise it to administrators. A keep-alive that fails because of a provider usage or rate limit
  MUST move it to cooling off instead, raising nothing — the credential is alive, which is what keep-alive was
  checking.
- **FR-038**: An agent credential and a scheduled keep-alive MUST NOT exercise the same credential concurrently.

#### Instance lifecycle

- **FR-039**: Pausing a workflow MUST bring the agent to a turn boundary, capture a durable snapshot, and then
  **stop** its instance while preserving its disk — superseding the "hold the process alive" behaviour of
  `002/FR-049`. This applies to **on-demand instances only**. A one-time spot instance cannot be stopped by the
  user at all, and spot is the platform default, so a spot pause MUST degrade to snapshot-and-terminate —
  routed through the FR-043 recovery path rather than implemented as a second one. Neither mode releases the
  credential lease (FR-040).
- **FR-040**: A paused workflow MUST retain its agent credential lease.
- **FR-041**: Resuming a paused workflow MUST start its existing instance and continue the same session against
  the same working tree, without re-provisioning, re-cloning or restoring from snapshot.
- **FR-042**: A paused workflow MUST incur storage cost but not compute cost, and this MUST be visible.
- **FR-043**: If a stopped instance cannot be started again, the workflow MUST be recovered from its durable
  snapshot onto a fresh instance holding the same credential, and the substitution MUST be recorded.
- **FR-044**: A workflow paused beyond the configured idle limit MUST be parked: released instance, released
  disk, work preserved durably, and reported as parked rather than failed. Its agent credential is **retained**
  (FR-073).
- **FR-045**: Parking MUST NOT release the instance or disk when the durable snapshot is not resumable; the
  condition MUST be raised instead.
- **FR-046**: Resuming a parked workflow MUST provision a fresh instance and MUST NOT wait for or reserve a
  credential, because it never released the one it holds.
- **FR-047**: The time remaining before a paused workflow parks MUST be visible to its owner.

#### Bootstrap and setup bundles

- **FR-048**: A setup bundle MUST NOT be required to install any agent credential; its responsibility is reduced
  to the agent CLI and non-agent credentials — superseding `002/FR-043` and `002/FR-075`.
- **FR-049**: Bootstrap MUST include a distinct, individually timed phase that installs the leased agent
  credential onto the instance, reported like every other bootstrap phase.
- **FR-050**: The credential-install phase MUST run on every boot, including a restore boot and a resumed-instance
  boot.
- **FR-051**: Failure of the credential-install phase MUST fail the workflow naming that phase, and the agent
  MUST NOT be started.
- **FR-052**: Bundle validation runs MUST remain possible without holding a credential, so proving a
  bundle does not consume pool capacity.

#### Observability and audit

- **FR-053**: The platform MUST provide an administrator-only pool view showing credentials grouped by
  credential group and, per credential: state, health, current holder and hold duration, last-used time,
  last-exercised time, and time until expiry where known.
- **FR-054**: The pool view MUST show the queue of workflows waiting for a credential, its depth and longest
  current wait, **broken down by credential group**, so an under-sized group is distinguishable from an
  under-sized pool.
- **FR-055**: Consumption and spend MUST be attributable per agent credential in addition to per workflow.
- **FR-056**: The platform MUST alert administrators on: a credential approaching expiry, a credential becoming
  unhealthy, a credential requiring re-login, and a lease held beyond a configurable expectation.
- **FR-057**: Administrators MUST be able to force-release a lease, and the forced release MUST resolve the
  affected workflow to a recorded state and be attributed to the acting administrator.
- **FR-058**: Every lease acquisition, release, forced release and credential state change MUST be recorded in
  the existing append-only configuration audit trail.
- **FR-059**: A workflow's record MUST name the single agent credential it used, for the platform's retention
  period.
- **FR-074**: The pool view MUST distinguish credentials held by **running**, **paused** and **parked**
  workflows, because a parked holder consumes capacity indefinitely while showing no activity, and is the
  likeliest cause of unexplained pool exhaustion.

---

### Key Entities

- **Agent credential** — a single agent identity the platform can perform work as, usable by one workflow at a
  time. Carries a name, an availability state (`awaiting login`, `available`, `held`, `cooling off`,
  `unhealthy`, `disabled`), the time it was last used and last exercised, any expected return time while cooling
  off, its owning credential group, and a pointer to its material in the secret store. Colloquially a **seat**.
- **Credential group** — a named collection of agent credentials and the unit by which capacity is reserved for
  a set of execution profiles. Each credential belongs to exactly one; each group may serve many profiles.
- **Profile group attachment** — the ordered association between an execution profile and a credential group,
  carrying the preference position that decides which group is drawn from first.
- **Agent credential material** — the mutable session data an agent credential authenticates with. Lives in the
  secret store, rotates during runs, is never stored in the database, in a bundle, or in a snapshot.
- **Lease** — an exclusive claim on an agent credential by one workflow, for that workflow's lifetime. Carries
  the holding workflow, acquisition time, release time and reason, and a monotonic fencing value.
- **Credential queue entry** — a workflow admitted but not yet granted a credential, carrying its admission
  order and the time it began waiting.
- **Keep-alive record** — the outcome of exercising an idle credential on a schedule, recorded against that
  credential.

---

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: An administrator can take a new agent identity from nothing to usable by the pool in a single
  session of under 5 minutes, without producing or uploading a setup bundle.
- **SC-002**: Across 100 consecutive workflows, no run fails because of a stale or conflicting agent credential.
- **SC-003**: Two workflows are never simultaneously authenticated as the same agent identity — zero
  occurrences under concurrent load equal to twice the pool size.
- **SC-004**: A workflow that cannot obtain a credential provisions no compute; billed compute for a
  waiting workflow is zero for the entire wait.
- **SC-005**: A workflow waiting for a credential starts within 30 seconds of one becoming available.
- **SC-006**: An engineer can tell, from the workflow view alone and without assistance, that a run is waiting
  for an agent credential and how long it has waited.
- **SC-007**: Resuming a paused **on-demand** workflow reaches its first agent turn at least 5× faster than
  starting an equivalent workflow from scratch. Spot runs resume from snapshot and are held to 002's resume
  performance instead; the two MUST be measured and reported as separate figures, because a single blended
  number would misrepresent both (FR-039).
- **SC-008**: A paused workflow's compute cost is zero for the duration of the pause.
- **SC-009**: No agent credential becomes unusable through disuse — zero expiry-through-idleness events over a
  30-day period in which at least one credential receives no workflow traffic.
- **SC-010**: A credential that becomes unhealthy is excluded from selection before it is issued to a second
  workflow.
- **SC-011**: An administrator can determine, in one view and under 30 seconds, which credential group is
  under-sized
  — that is, whether workflows are waiting and for how long.
- **SC-012**: A broken credential can be returned to service by an administrator in under 5 minutes, affecting
  no run on any other credential.
- **SC-013**: 100% of lease acquisitions, releases and credential state changes are attributable to a workflow
  or a named administrator for the platform's retention period.
- **SC-014**: No credential material appears in any log, snapshot, job envelope, bundle archive, or
  administrator-visible surface — zero occurrences under audit.
- **SC-015**: A stranded lease is never permanent: every lease whose workflow has ceased to exist is released
  within one reconciliation interval.
- **SC-016**: Work launched under an execution profile is never performed by an agent credential outside that
  profile's attached groups — zero occurrences under audit across all runs.
- **SC-018**: Every workflow is performed end to end by exactly one agent credential — zero occurrences of a
  workflow spanning two identities, including across pauses, parks and environment rebuilds.
- **SC-019**: A credential that hits a provider usage or rate limit returns to service without any administrator
  action, and generates no alert.
- **SC-020**: A run whose credential hits a provider limit resumes when the limit clears rather than failing —
  zero runs failed for a limit that later cleared.
- **SC-017**: Saturating one credential group causes no workflow under a profile attached only to other groups
  to wait.

---

## Assumptions

- **The agent's credential rotates and can expire through disuse.** Both the exact rotation semantics (whether a
  superseded credential is invalidated immediately or tolerates a reuse window) and the idle-expiry window are
  **unknown and must be established empirically before planning**. They determine how damaging an
  unpersisted rotation is and how often keep-alive must fire; this specification states the required behaviour
  rather than the mechanism, so both remain answerable during design.
- **Nobody is currently using the platform**, so no migration path is required for in-flight workflows,
  existing bundles carrying agent credentials, or historical runs.
- **The number of seats is an operational decision, not a platform constraint.** The platform's obligation is to
  make under-sizing visible; buying capacity is the operator's response.
- **One agent credential is usable from one place at a time — with no exemptions.** This is the constraint the
  whole design serves, and it is applied uniformly even to credential kinds that could tolerate concurrent use.
  The cost is accepted deliberately: a metered API key that could serve many workflows at once serves exactly
  one, and concurrency on such a key is bought by registering it as several credentials rather than by relaxing
  the rule.
- **Pausing uses instance stop with disk retention — on on-demand instances.** A paused workflow's session
  stays on that disk. Durable snapshots remain the recovery path, not the resume path. **This assumption does
  not hold for spot**, which cannot be stopped and is the current platform default: those pauses snapshot and
  terminate, and snapshots remain both recovery and resume path for them. Changing the default purchase mode is
  a cost decision belonging to whoever owns the spend, and is deliberately out of scope here.
- Existing platform mechanisms are reused rather than rebuilt: the workflow-scoped credential for fetching, the
  output redaction pipeline, the reconciliation sweep and heartbeat, the append-only configuration audit, the
  notification system, and the administrator role.
- **Agent credentials are partitioned into groups, not pooled globally.** A credential belongs to exactly one
  group; an execution profile draws from the ordered set of groups attached to it. Capacity is therefore a
  property of a group rather than of the platform, which is why the queue view reports per group.
- **The size and shape of the grouping is an operational decision.** One group attached to every profile
  reproduces a single shared pool; one group per client reproduces strict separation; a client group plus a
  shared overflow group gives separation with burst capacity. The platform does not prefer any of these.

---

## Out of Scope

- Reducing cold-start time for workflows that are **not** resuming from a pause. Instance image baking and warm
  workspace caches are separate concerns and are not addressed here.
- Engineer-facing notifications for waiting, cooling off or parking. These states are visible in the workflow
  view and are deliberately not pushed; only administrator pool alerting (FR-056) is in scope.
- Automating the initial login. Establishing an agent identity's session is assumed to require a human once per
  credential.
- Purchasing, provisioning or de-provisioning agent identities with any external vendor. The platform manages
  credentials it is given.
- Changing how spend caps are enforced. Attribution moves to include the credential; enforcement is unchanged.
- Multi-region or multi-account pooling.
