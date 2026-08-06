import type { Artifact, LogSegment } from '../../db'
import {
  listWorkflowsInput,
  logSegmentsInput,
  spendSummaryInput,
  startAdHocInput,
  startWorkflowInput,
  workflowIdInput,
} from '../../schemas'
import { adminProcedure, createTRPCRouter, scopedProcedure } from '../procedures'

import type { LaunchableWorkspace } from './ad-hoc-workspace'
import { listLaunchableWorkspaces } from './ad-hoc-workspace'
import { correctionsProcedure, correctProcedure } from './corrections'
import type { WorkflowPage } from './filters'
import type { IterationPass } from './iterations'
import { readIterations } from './iterations'
import { reassignOwnerProcedure } from './ownership'
import type { SpendSummary, TimelineEntry, WorkflowDetail, WorkflowListing } from './queries'
import {
  listWorkflows,
  readArtifacts,
  readLogSegments,
  readTimeline,
  readWorkflowDetail,
  summariseSpend,
} from './queries'
import { skillReferencesProcedure } from './skills'
import { spendAttributionProcedure } from './spend'
import type { StartedWorkflow } from './start'
import { startWorkflow } from './start'
import type { StartedAdHocWorkflow } from './start-ad-hoc'
import { startAdHocWorkflow } from './start-ad-hoc'
import { chainProcedure, continueWithChangesProcedure } from './successor'
import { pauseProcedure, resumeProcedure, stopProcedure } from './supervision'
import {
  notificationPreferencesProcedure,
  setNotificationPreferenceProcedure,
  unwatchProcedure,
  watchProcedure,
} from './watch'

/**
 * The `workflow` sub-router — the panel's whole read surface for runs, plus the one write that
 * starts one (FR-012, FR-013, FR-014, FR-016, FR-046).
 *
 * ## Every procedure here is a `scopedProcedure`, with two named exceptions
 *
 * The exceptions are `startAdHoc` and `adHocWorkspaces`, which are `adminProcedure`. An ad hoc
 * launch names no execution profile, so there is nothing for a scope to constrain — the gate has
 * to be the role instead (FR-187). Both are stated as exceptions here rather than being inferred
 * from the absence of a scope.
 *
 * Everything else is scoped, `start` included. `api-surface.md` lists `start` as
 * `authedProcedure` + a profile-grant check, and `scopedProcedure` **is** `authedProcedure` plus
 * that grant set already resolved — the same `visibleProfileIds` FR-180's check needs, memoised so
 * it costs one query for the whole request. Building `start` on the narrower base would mean
 * resolving the caller's grants a second time, by a second route, with its own opinion of what a
 * live grant is. This is a strict refinement of the contract, not a relaxation of it: no procedure
 * on this router is reachable without a session, and none of the scoped ones without a resolved
 * scope.
 *
 * ## Where the authorisation actually lives
 *
 * Not in this file. Every read delegates to `./queries.ts`, where the FR-190 base selector is
 * composed into the statement itself; every id-taking read goes through `requireWorkflowInScope`,
 * so an out-of-scope id and a nonexistent one produce the same `NOT_FOUND` with the same message
 * and there is no enumeration oracle. A resolver here that assembled its own `where` would have
 * re-derived the rule, and the failure mode when it got it wrong would be silence.
 *
 * ## Recording a refused launch
 *
 * FR-180 asks for a refused launch to be **recorded**. `AuthorisationDenial` in `context.ts` now
 * carries a `profile_not_granted` reason for exactly this: the caller's role is not the problem, so
 * filing it as `not_admin` would make the trail say something untrue. The *refusal* stays
 * `NOT_FOUND` with the message a nonexistent profile gets — FR-190 forbids the response confirming
 * the profile exists — and only the recorded event knows the difference.
 */
export const workflowRouter = createTRPCRouter({
  /**
   * Launch a run from an execution profile (FR-016, FR-122, FR-180).
   *
   * Writes a `queued` row and returns. The panel never invokes the control plane — see the module
   * comment in `./start.ts` for why that is what makes FR-035's no-ingress rule structural.
   */
  start: scopedProcedure
    .input(startWorkflowInput)
    .mutation(
      async ({ ctx, input }): Promise<StartedWorkflow> =>
        startWorkflow({ db: ctx.db, scope: ctx.scope, actorUserId: ctx.user.id, input }),
    ),

  /**
   * Launch with no execution profile (FR-016, FR-129, FR-187) — **the one `adminProcedure` here.**
   *
   * Every other procedure on this router is scoped; this one is gated instead, and the difference
   * is the point. A scoped launch is constrained by the profiles the caller holds, and an ad hoc
   * launch names no profile — so scoping it would constrain nothing. `adminProcedure` refuses a
   * non-admin and **records the attempt** as a `not_admin` denial before the resolver is reached,
   * which is what stops FR-180 being satisfiable by declining to name a profile.
   *
   * Writes a `queued` row and returns, exactly as `start` does. See `./start-ad-hoc.ts`.
   */
  startAdHoc: adminProcedure
    .input(startAdHocInput)
    .mutation(
      async ({ ctx, input }): Promise<StartedAdHocWorkflow> =>
        startAdHocWorkflow({ db: ctx.db, actorUserId: ctx.user.id, input }),
    ),

  /**
   * The workspaces the ad hoc launch form may offer (FR-016).
   *
   * `adminProcedure` because it exists solely to populate that form, and the form is admin-only.
   * It is not a general workspace read — the admin surface owns that — and it deliberately answers
   * with only what a picker renders, so it cannot become the route by which workspace
   * configuration leaks onto a non-admin screen.
   */
  adHocWorkspaces: adminProcedure.query(
    async ({ ctx }): Promise<readonly LaunchableWorkspace[]> => listLaunchableWorkspaces(ctx.db),
  ),

  /** The panel's primary list, scoped, filtered and keyset-paginated (FR-012, FR-013, FR-190). */
  list: scopedProcedure
    .input(listWorkflowsInput)
    .query(
      async ({ ctx, input }): Promise<WorkflowPage<WorkflowListing>> =>
        listWorkflows({ db: ctx.db, scope: ctx.scope, input }),
    ),

  /** One run in full (FR-014). `NOT_FOUND` when it is outside the caller's scope (FR-190). */
  byId: scopedProcedure
    .input(workflowIdInput)
    .query(
      async ({ ctx, input }): Promise<WorkflowDetail> =>
        readWorkflowDetail({ db: ctx.db, scope: ctx.scope, workflowId: input.workflowId }),
    ),

  /** The append-only lifecycle timeline, oldest first (FR-014, FR-064). */
  timeline: scopedProcedure
    .input(workflowIdInput)
    .query(
      async ({ ctx, input }): Promise<readonly TimelineEntry[]> =>
        readTimeline({ db: ctx.db, scope: ctx.scope, workflowId: input.workflowId }),
    ),

  /**
   * Log segments from `fromSequence` onward (FR-046).
   *
   * The polling half of the log view; the SSE route is the streaming half and is scoped the same
   * way. Both answer `NOT_FOUND` for a run the caller may not see, so a log cannot be used to
   * discover that a run exists.
   */
  logSegments: scopedProcedure.input(logSegmentsInput).query(
    async ({ ctx, input }): Promise<readonly LogSegment[]> =>
      readLogSegments({
        db: ctx.db,
        scope: ctx.scope,
        workflowId: input.workflowId,
        fromSequence: input.fromSequence,
      }),
  ),

  /** Everything the run produced, expired objects included with their expiry (FR-014, SC-012). */
  artifacts: scopedProcedure
    .input(workflowIdInput)
    .query(
      async ({ ctx, input }): Promise<readonly Artifact[]> =>
        readArtifacts({ db: ctx.db, scope: ctx.scope, workflowId: input.workflowId }),
    ),

  /**
   * Grouped spend (FR-156, SC-051).
   *
   * On this router rather than deferred, because it is the aggregate FR-190 is most easily broken
   * on and the leak contract in `./queries.test.ts` has to be able to call it as a real procedure
   * rather than as a helper nothing mounts.
   */
  spendSummary: scopedProcedure
    .input(spendSummaryInput)
    .query(
      async ({ ctx, input }): Promise<SpendSummary> =>
        summariseSpend({ db: ctx.db, scope: ctx.scope, input }),
    ),

  /**
   * The same aggregate, attributed (FR-156, SC-051) — **not a second spend read.**
   *
   * `spendSummary` answers "what did it cost, grouped how you asked"; `spendAttribution` answers
   * the FR-156 question on top of it: for a per-individual grouping, a non-admin is entitled to
   * exactly one row — their own — and an admin to all of them. It composes `summariseSpend` rather
   * than querying again, so there is one scoped aggregate in the package and one place FR-190 has
   * to hold for it. See `./spend.ts`.
   */
  spendAttribution: spendAttributionProcedure,

  /**
   * What the run resolved, and what it could not (FR-059, SC-016).
   *
   * Scoped like every other id-taking read, and deliberately not answerable with an empty list for
   * a run outside the caller's scope: "this run resolved no skills" and "there is no such run" are
   * different sentences, and only the second may be said (FR-190).
   */
  skillReferences: skillReferencesProcedure,

  /**
   * The passes of an autonomous run, with the findings each raised (FR-061, FR-062).
   *
   * Scoped, so an out-of-scope run answers `NOT_FOUND` rather than an empty history — an empty
   * list would say the run exists and simply has no passes, which for a run the caller may not see
   * is a disclosure. See `./iterations.ts` for why this does not share the machine surface's
   * `iterationHistory`.
   */
  iterations: scopedProcedure
    .input(workflowIdInput)
    .query(
      async ({ ctx, input }): Promise<readonly IterationPass[]> =>
        readIterations({ db: ctx.db, scope: ctx.scope, workflowId: input.workflowId }),
    ),

  /**
   * Reassignment of the one human owner (FR-132, FR-133). `adminProcedure`, because taking a run
   * off the person it was delegated to is an administrative act, not a self-service one.
   */
  reassignOwner: reassignOwnerProcedure,

  /**
   * Watching and notification preferences (FR-138, FR-188, FR-190).
   *
   * `watch`/`unwatch` are `scopedProcedure`, so neither can be used to confirm that an
   * out-of-scope workflow exists — the refusal is the same `NOT_FOUND` a nonexistent id gets. The
   * preference procedures are `authedProcedure`: they name no workflow, so there is nothing for a
   * scope to constrain.
   */
  watch: watchProcedure,
  unwatch: unwatchProcedure,
  notificationPreferences: notificationPreferencesProcedure,
  setNotificationPreference: setNotificationPreferenceProcedure,

  /**
   * Supervision (FR-044, FR-049, FR-081, SC-003).
   *
   * These queue a `supervision_commands` row and return; the instance collects it on its next poll.
   * The panel does not reach the instance — the same no-ingress shape as `start`. A run that has
   * already finished answers with an already-finished response rather than an error (FR-081):
   * pausing something that stopped is a no-op with an explanation, not a failure.
   */
  pause: pauseProcedure,
  resume: resumeProcedure,
  stop: stopProcedure,

  /** Corrections into the live conversation — exactly once, in submission order (FR-044). */
  correct: correctProcedure,
  corrections: correctionsProcedure,

  /**
   * Continue a capped run as a **successor**, not as an edit (FR-149, FR-150, FR-151).
   *
   * A job specification is immutable for a workflow's lifetime, so raising a cap creates a new run
   * linked to the one it continues rather than rewriting it. Continuing with no change at all is
   * refused and pointed at `resume` — see `./successor.ts`.
   */
  continueWithChanges: continueWithChangesProcedure,

  /**
   * The successor chain, in **both** directions (FR-152, FR-190).
   *
   * The forward half is the one no workflow read can provide: finding the run that continues a
   * given one is a reverse lookup on `predecessor_workflow_id`. Every hop composes the same base
   * selector, so a chain member the caller may not see is absent, unnamed and uncounted — which
   * means the summed consumption is honestly a total for the visible chain.
   */
  chain: chainProcedure,
})

export type WorkflowRouter = typeof workflowRouter
