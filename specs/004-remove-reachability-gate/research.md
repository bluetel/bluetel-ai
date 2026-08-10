# Phase 0 Research: Remove the repository-reachability half of the profile enable gate

**Feature**: `specs/004-remove-reachability-gate` | **Date**: 2026-08-09

The spec carried no `[NEEDS CLARIFICATION]` markers, so this document records the decisions the
implementation rests on rather than resolving open questions. Each is stated with what was chosen, why, and
what was rejected — because the defect being removed was itself the residue of a decision whose rationale was
never written down.

## R1. Withdraw the requirement rather than implement it

**Decision.** Delete the reachability check. Do not build any replacement.

**Rationale.** The check needs a credential that can read a client's repositories. The tracing done before this
spec establishes where that credential actually lives:

- `contracts/setup-bundle.md` makes installing "the repository-host credentials" a responsibility of the
  client-authored `setup.sh`, written under `/workspace/.agent-config/credentials/` — a directory whose
  contents the contract explicitly declines to specify ("optional, whatever setup.sh needs").
- `bootstrap/workspace.ts` clones with a bare `git clone --branch <b> --single-branch <url> <path>`. No token,
  no auth argument. Credentials are resolved **from ambient state** — whatever global git configuration
  `setup.sh` left on the instance — rather than passed in.
- `run/forge-credential.ts` documents why nothing may read those files by name: inventing a path such as
  `credentials/forge-token` "would be a change to the bundle format dressed up as an implementation detail",
  and every bundle already authored against the contract's freedom would silently fail. When the executor needs
  the same credential later it asks git via `git credential fill` rather than reading a file.
- The credential is deliberately excluded from snapshots (FR-072), which is why bootstrap phases 2–5 re-run on
  a restore boot.

So the credential exists only on an ephemeral instance, in a shape the platform has promised not to know. The
panel cannot obtain it, and no amount of implementation changes that. A requirement that cannot be satisfied is
withdrawn, not scheduled.

**Alternatives considered.**

| Alternative                                        | Rejected because                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Give the platform its own code-host credential     | It would verify with a **different** credential from the one runs use, so the gate could pass while the run fails and vice versa — a check that reports on the wrong subject is worse than none. Also needs a new secret in `env-schemas.ts`, a URL parser, and per-host adapters this tool does not need. |
| Probe from an instance, reusing `bundles.validate` | Architecturally correct — that instance holds the real credential, and the verdict could be stored and read locally at enable time. Rejected as disproportionate: it is a control-plane job change, a schema change and a new per-entry verdict store, for a tool with a handful of admin users.           |
| Keep the seam, default it to always-reachable      | Preserves the exact trap being removed. A seam nobody can implement, defaulted to "yes", reports a check that did not happen — the specific failure `reachability.ts`'s own header argues against, merely inverted.                                                                                        |
| Keep the seam behind an environment flag           | Same objection plus a permanently-off configuration switch, which is a second thing to explain and a second way to re-enable an inoperable state.                                                                                                                                                          |

## R2. Keep the five local checks

**Decision.** Retain: published version exists; pinned bundle and workspace version rows readable; bundle
enabled and not archived; workspace not archived; workspace version holds at least one entry.

**Rationale.** These read data the platform already owns, cost one query that `readProfileEnableSubject`
already performs, and each catches a real misconfiguration — a bundle disabled out from under a profile, a
workspace emptied by an edit. The empty-workspace check in particular prevents a run that would provision a
paid instance and reach phase 6 with nothing to check out. Only the check requiring an unobtainable credential
is withdrawn; removing the others would trade one broken behaviour for another.

**Alternative rejected.** Removing the whole gate and letting `setEnabled` write unconditionally. Simpler, but
it discards working checks to fix an unrelated one, and FR-124 would have to be withdrawn entirely rather than
narrowed.

## R3. `checkProfileCanBeEnabled` becomes synchronous

**Decision.** Change the signature from
`(subject, probe) => Promise<ProfileEnableCheck>` to `(subject) => ProfileEnableCheck`.

**Rationale.** The probe was the function's only source of asynchrony; everything else it judges arrives on
`ProfileEnableSubject`, already read. Leaving it `async` would preserve a `Promise` that can never be pending
and would let a future outbound call be slipped back in without anyone noticing the signature already permitted
it. A synchronous, total function over a value is the strongest available statement that this gate does no I/O
— which is exactly what SC-002 and SC-005 assert.

**Consequence.** `runEnableGate` in `profiles.ts` stays `async` — it still awaits `findProfileVersion` and
`readProfileEnableSubject` — but its final line stops being an `await`.

**Alternative rejected.** Keeping `async` for signature stability. There are two call sites, both in this
repository, both changing in this commit; stability buys nothing.

## R4. Collapse `createProfilesRouter` into `profilesRouter`

**Decision.** Delete `ProfilesRouterOptions` and the factory. Export the router directly, as
`workspacesRouter` and the other sub-routers already are.

**Rationale.** The factory exists solely to inject the probe — its own doc comment says so ("The probe is an
argument because FR-124's check is an outbound call"). With no injectable left, a factory taking an empty
options object is ceremony that invites something to be threaded through it later. The two callers are
`profiles.test.ts` and `workflow/launch-configuration.test.ts`, both of which become simpler by importing the
router.

**Note on the two-source lookup.** `profiles.ts` currently resolves the probe as
`ctx.dependencies.repositoryReachability ?? options.reachability` — a per-request override falling back to a
construction-time default. Both sides disappear together; there is no intermediate state where one remains.

## R5. `repositoryReachability` leaves `SisyphusDependencies`

**Decision.** Remove the optional field from `context.ts`.

**Rationale.** It is optional and no host sets it — `apps/sisyphus-admin/src/server/dependencies.ts` supplies
four dependencies and this is not among them, which is precisely why the refusing default was reached in
production. An optional dependency that nothing supplies and nothing reads is dead surface on a type every host
implements.

**Care required.** The doc comment on the sibling field `notifier` contrasts itself against
`repositoryReachability` to explain why an absent notifier is a silent no-op while an absent probe refuses.
That contrast must be rewritten, not left dangling at a `{@link}` to a deleted member — a broken `{@link}` is
both a lint concern and a lost explanation.

## R6. `workspace_entry` leaves both closed sets

**Decision.** Remove the member from `PROFILE_ENABLE_ELEMENTS` (server) and `ENABLE_FAILURE_ELEMENTS` (panel),
along with its `ACTIONS` entry and its branch in `classifyEnableFailure`.

**Rationale.** Both sets are closed and documented as such, so a member the server can no longer emit is
unreachable code that still shapes an exhaustive `Record`. The panel's classifier is explicitly a _narrowing_
with an `unclassified` fallback, so dropping the branch is safe by its own design: a line it cannot classify
still gets a code, an action and its verbatim text.

**Consequence for administrators.** The error code `E_PROFILE_ENABLE_WORKSPACE_ENTRY` disappears. It may be
quoted in tickets or saved links. Nothing needs to redirect it — the condition that produced it no longer
exists — but the panel must keep degrading unknown lines gracefully, which FR-010 requires and the existing
fallback already provides.

## R7. Two stale precedents must be corrected, not left

**Decision.** Rewrite the doc comments in `server/notify/emitter.ts` and
`apps/sisyphus-control-plane/src/jobs/prompt-redact.ts` that cite the refusing probe as the model for their own
defaults.

**Rationale.** Both cite `admin/reachability.ts` to justify a refuse-or-no-op default. After deletion those
references point at nothing, and — worse — they transmit the lesson that produced this defect. The correction
carries the distinction that was missed: refusing closed is right where the refusal is survivable, and both of
those paths are (an unwired notifier withholds a message; an unwired redactor refuses one job), whereas the
profile gate sat on the primary launch path where "safe default" and "product inoperable" were the same state.

## R8. `knip.json` is part of this change

**Decision.** Delete the `"!src/server/admin/reachability-fake.ts!"` production-only exclusion in the same
commit as the file.

**Rationale.** The constitution states that where a tool's configuration and the code disagree, "that is a
defect: one of the two MUST be corrected in the same change that discovers it". An exclusion naming a deleted
file is stale config, and the orphan gate (SC-063) is exactly the gate whose credibility depends on its
configuration describing reality. Left in place it is harmless today and misleading permanently.

## R9. Test strategy — the retained checks gain coverage

**Decision.** Rewrite `profile-gate.test.ts` around one assertion per retained refusal, plus the
report-everything-together case. Do not merely delete the reachability cases.

**Rationale.** Several retained behaviours are currently asserted only incidentally, as the passing half of a
reachability test — for example "reports a disabled bundle and an unreachable entry together" is today the only
test of multi-failure collection. Deleting the reachability cases without restating what they incidentally
covered would silently reduce coverage of the checks being kept, which is the failure mode US2 exists to guard
against. `profiles.test.ts` keeps its database-backed enable tests, with the entry-unreachable cases replaced
by the empty-workspace and archived-bundle refusals.

**Verification that the gate still bites.** Per the lesson recorded in `specs/002`'s plan — "every gate should
be tested against a known failure before it is trusted" — each retained refusal is asserted by constructing a
subject that violates it and observing the refusal, not by observing a pass.
