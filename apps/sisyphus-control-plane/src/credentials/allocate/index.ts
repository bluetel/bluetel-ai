/**
 * Allocation — deciding *which* credential a workflow should be offered, and nothing else.
 *
 * One function is reachable from here, and that is the whole design. `selectFor` is where SC-016
 * lives: candidates are reached by joining out from the workflow row to its own execution profile's
 * attached groups, so no credential outside them can be returned by any code path, and the only
 * parameter is the workflow's id. Adding a group- or profile-scoped variant to this barrel would
 * move that guarantee from the query to every caller.
 *
 * **Selection makes no claim.** It takes no lock, writes nothing, and two callers can legitimately
 * be offered the same credential. Turning an offer into a seat is `../lease/acquire.ts`, whose
 * conditional update and partial unique index are what resolve the race — and that separation is
 * deliberate: exclusivity is a database guarantee, and a "selectAndClaim" here would be the seam
 * through which it leaked.
 *
 * **`describeWaitReason` is the other half of the same absence.** Selection reports "nothing" by
 * returning no row, which is the right shape for the decision on the admission path and useless to
 * whoever has to act on it: all held, all cooling off, all unhealthy and a group holding nothing at
 * all are four different problems with four different remedies (FR-029). It is exported here rather
 * than left inside `select.ts` because it is a *second* pass over the same graph, deliberately not
 * paid for by the runs that get a seat — see `wait-reason.ts`. It classifies; it claims nothing and
 * changes nothing, which is the same rule the rest of this barrel keeps.
 *
 * `pool-fixtures.ts` is deliberately absent. It is test support for the suites in this directory
 * and in `../lease/`, and exporting it would put a scratch-database seeder — one that creates and
 * drops databases — one import away from the allocator. `index.test.ts` asserts that absence rather
 * than trusting this paragraph.
 *
 * Consumers import this barrel, never a module underneath it. This directory holds 003's agent
 * credential pool; the `mint.ts`/`revoke.ts` beside its parent are 002's workflow-scoped JWT and
 * are an unrelated thing that shares a word — see `../index.ts`.
 */

export { selectFor } from './select'
export type { SelectedCredential, SelectForOptions, SelectionReader } from './select'
export { describeWaitReason } from './wait-reason'
export type {
  CredentialCensus,
  DescribeWaitReasonOptions,
  SearchedGroup,
  WaitReason,
  WaitReasonKind,
} from './wait-reason'
