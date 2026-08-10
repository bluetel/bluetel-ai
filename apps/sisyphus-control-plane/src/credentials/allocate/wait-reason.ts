import type { AgentCredential } from '@bluetel-ai/sisyphus-api/db'
import {
  agentCredentials,
  credentialGroups,
  profileCredentialGroups,
  workflows,
} from '@bluetel-ai/sisyphus-api/db'
import { and, asc, eq, isNull } from 'drizzle-orm'

import type { SelectionReader } from './select'

/**
 * Why a workflow is waiting — FR-029, and the reason `selectFor` returning `undefined` is not an
 * answer anybody can act on.
 *
 * Selection is a single statement that returns at most one row, and the *absence* of that row is
 * the whole of what it says. That is the right shape for the decision it serves — do not provision
 * compute — and the wrong shape for the person who then has to do something about it. Four
 * situations produce the same empty result set and every one of them has a different remedy:
 *
 * | What is true                                    | What somebody should do                     |
 * | ----------------------------------------------- | ------------------------------------------- |
 * | every reachable credential is **held**          | add capacity, or wait for a run to finish   |
 * | every one is **cooling off**                    | wait; a provider limit clears by itself     |
 * | every one is **unhealthy or disabled**          | an administrator has to repair or re-enable |
 * | the attached groups hold **no credentials**     | fix the configuration; nothing will drain   |
 *
 * A platform that answers "no capacity" to all four sends an engineer to look at the pool size when
 * the actual fault is a credential nobody has logged in yet, and — worse — lets the fourth case sit
 * in a queue until FR-028's limit expires it. **The fourth case is not a wait at all.** No release
 * by any other run, and no amount of patience, adds a credential to a group that has none; it is a
 * mistake, and this module says so with {@link WaitReason.configurationFault} rather than leaving
 * it to be inferred from a sentence.
 *
 * ## It names the groups, because "which pool" is half the question
 *
 * FR-029 asks for the attached groups to be named, and the reason is the same one
 * `execution-profile` scoping exists for: a credential is only reachable through a group its
 * profile is attached to (FR-063), so "the pool is exhausted" is never a statement about *the*
 * pool. An engineer told that a run is waiting has to know which groups were searched before they
 * can tell whether the answer is to register a credential, to attach another group, or to wait for
 * one particular team's seats to free up. The groups are listed **in preference order**, matching
 * the order selection tried them in, so the list reads as the search that was actually performed.
 *
 * ## Why the census is recomputed rather than read off selection
 *
 * `selectFor` is deliberately a `limit 1` — it is on the admission path and it stops looking the
 * moment it has an answer. Classifying a wait means counting *every* reachable credential, which is
 * a strictly more expensive query, and running it inside selection would make every successful
 * admission pay for a report only a failed one needs. So this is a second pass over the same graph,
 * and it runs only when there was nothing to select.
 *
 * The two queries have to agree about what "reachable" means, and there is no way to make that a
 * shared expression without one of them growing conditions the other does not want. What is done
 * instead is to make the disagreement visible: {@link CREDENTIAL_BUCKETS} has an `available` member
 * and {@link WaitReason.kind} has {@link SEAT_AVAILABLE}, so a census that finds a selectable
 * credential where selection found none reports that plainly rather than misfiling it as
 * exhaustion. That is a real situation and not only a bug — a seat can be released between the two
 * statements — and it is the honest thing to say when it happens.
 *
 * ## A run with no execution profile is a configuration fault, not a wait
 *
 * `workflows.execution_profile_id` is nullable: 002/FR-126 leaves it null for an ad-hoc run.
 * Selection joins out through it, so such a run reaches no group at all — and, crucially, **no
 * grant can ever reach it either**, because the grant path joins through the same attachments. A
 * queue it can never be served from is not a queue, so this reports it as its own kind
 * ({@link NO_EXECUTION_PROFILE}) and marks it a configuration fault. `admit-workflow.ts` uses that
 * distinction to keep such a run out of `awaiting_credential` entirely.
 *
 * ## Archived rows are not capacity
 *
 * An archived credential is excluded from the census outright, so a group whose only members have
 * been archived reports as holding **no credentials** rather than as holding disabled ones — soft
 * deletion is how this feature deletes (FR-005, FR-066), and a report that saw through it would
 * describe capacity an administrator believes is gone. An archived *group*, by contrast, is still
 * named: the profile is attached to it, that attachment is the fault, and a report that silently
 * dropped it would leave an engineer looking for a group the profile no longer appears to want.
 */

/** What the census can conclude about one credential. Ordered from most to least promising. */
export const CREDENTIAL_BUCKETS = ['available', 'held', 'cooling_off', 'unavailable'] as const

export type CredentialBucket = (typeof CREDENTIAL_BUCKETS)[number]

/** A seat is selectable after all — the wait should end on the next drain, not on a repair. */
export const SEAT_AVAILABLE = 'seat_available'

/** The run has no execution profile, so no group was searched and none ever will be. */
export const NO_EXECUTION_PROFILE = 'no_execution_profile'

/** The profile has no attached credential groups (FR-065 refuses this at save time). */
export const NO_GROUPS_ATTACHED = 'no_groups_attached'

/** The attached groups exist and hold no credentials at all — the FR-029 configuration fault. */
export const NO_CREDENTIALS = 'no_credentials'

/**
 * Every kind of answer this module gives.
 *
 * Written as a closed list rather than as free text because the four FR-029 cases are a
 * *classification*: the panel picks copy from it, T067's expiry names it in the failure it records,
 * and a future alert will branch on it. A sentence alone would make all three parse English.
 */
export const WAIT_REASON_KINDS = [
  SEAT_AVAILABLE,
  'all_held',
  'all_cooling_off',
  'all_unhealthy_or_disabled',
  'mixed',
  NO_CREDENTIALS,
  NO_GROUPS_ATTACHED,
  NO_EXECUTION_PROFILE,
] as const

export type WaitReasonKind = (typeof WAIT_REASON_KINDS)[number]

/** The kinds that no release and no waiting will resolve. Somebody has to change something. */
export const CONFIGURATION_FAULT_KINDS: readonly WaitReasonKind[] = [
  NO_CREDENTIALS,
  NO_GROUPS_ATTACHED,
  NO_EXECUTION_PROFILE,
]

/** One group the search covered, as the report names it. */
export interface SearchedGroup {
  readonly credentialGroupId: string
  readonly name: string
  /** The attachment's preference position — 1 is the profile's first choice. */
  readonly position: number
  /**
   * False for a group that is disabled or archived. Named anyway: the attachment is real, and it is
   * very often the fault itself.
   */
  readonly usable: boolean
}

/** How many reachable credentials fell into each bucket. Sums to {@link CredentialCensus.total}. */
export interface CredentialCensus {
  readonly available: number
  readonly held: number
  readonly coolingOff: number
  /** Unhealthy, disabled, awaiting a login, or withheld by a disabled or archived group. */
  readonly unavailable: number
  readonly total: number
}

/** Why one workflow is waiting, in the terms FR-029 asks for. */
export interface WaitReason {
  readonly kind: WaitReasonKind
  /**
   * True when no release and no delay resolves this — the queue will not drain, because there is
   * nothing behind it to drain. The single most important field here: it is the difference between
   * a run that is going to start and a run that is going to sit until FR-028's limit expires it.
   */
  readonly configurationFault: boolean
  /**
   * Whether a grant could **ever** reach this run.
   *
   * False for exactly one kind, {@link NO_EXECUTION_PROFILE}, and the asymmetry is worth stating
   * because it is easy to read the other faults as equally hopeless and they are not. A profile
   * with no attachments, or an attached group holding no credentials, is fixed by an administrator
   * editing the *profile* or registering a *credential* — after which the grant path, which joins
   * waiting runs to their profile's attachments, reaches this run and grants it a seat with no
   * further help. `execution_profile_id` on the workflow row is not like that: it is fixed at
   * launch, and a run that has none can only be relaunched.
   *
   * `admit-workflow.ts` branches on this rather than on {@link WaitReason.kind}, so the vocabulary
   * of reasons stays here and the admission path asks the only question it actually has: is putting
   * this run in the queue going to serve it?
   */
  readonly grantable: boolean
  /** The attached groups, in preference order — the search that was performed (FR-029). */
  readonly groups: readonly SearchedGroup[]
  readonly census: CredentialCensus
  /** One sentence saying what is true, naming the groups. Rendered verbatim. */
  readonly summary: string
  /** One sentence saying what would change it. Never merged into the summary; they differ. */
  readonly remedy: string
}

export interface DescribeWaitReasonOptions {
  /**
   * The workflow that found nothing. The only input, exactly as {@link import('./select').selectFor}
   * takes only a workflow id — the profile and its attachments are resolved inside the query, so no
   * caller can widen the set of groups this reports on.
   */
  readonly workflowId: string
}

/** See `select.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** One credential as the census sees it. Identifiers and states only; never any material. */
export interface CensusCandidate {
  /** False when the group it belongs to is disabled or archived, which withholds every member. */
  readonly groupUsable: boolean
  readonly enabled: boolean
  readonly state: AgentCredential['state']
  /** Null is FR-008: nowhere to fetch material from, so unusable whatever the state column says. */
  readonly secretId: string | null
}

/**
 * Which bucket one credential falls into.
 *
 * Pure, exported and tested directly, because this is the rule and a rule embedded in a `select` is
 * a rule that can only be asserted by seeding a database. The order of the checks is the rule
 * itself: the group is asked about **first**, so a credential that is merely `held` inside a
 * disabled group counts as unavailable rather than as capacity that is coming back. It is not
 * coming back — releasing it returns it to a group selection cannot reach.
 *
 * **The credential's own `enabled` flag is asked at the same moment, and that is the FR-029 edge a
 * recovery produces** (T115, T120, SC-012). The US9 sequence is: a run holds the only seat a
 * profile can reach, other runs queue behind it, and an administrator then disables that seat
 * because its login has broken — disabling being the first step of recovering it, and one that by
 * design evicts nobody (FR-006). At that instant the queue's premise quietly stops being true. The
 * seat is still `held`, the run still holds it, and the release is still coming; what is no longer
 * coming is any **capacity**, because a disabled credential is withheld from selection whatever its
 * state column says.
 *
 * Ask `state` before `enabled` and the census reports that seat as `held`, the classification says
 * `all_held`, and the remedy tells an engineer to wait for a run to finish — for a seat that will
 * be withheld the moment that run ends. That is precisely a queue waiting on capacity that will
 * never arrive, and it is the failure FR-029's third case exists to separate from its first. The
 * two checks are therefore in this order deliberately and not incidentally, which is why they are
 * pinned by a case of their own rather than left to the `available` one that happens to cover them.
 *
 * `available` with no `secret_id` is likewise unavailable rather than available. That is FR-008 as
 * a data rule and it mirrors `selectFor`'s `secret_id is not null`: a credential with nowhere to
 * fetch material from cannot be handed to a workflow by any code path, and a census that counted it
 * would report a seat the selection query has already refused.
 *
 * @param candidate - One reachable credential.
 */
export const bucketFor = (candidate: CensusCandidate): CredentialBucket => {
  if (!candidate.groupUsable || !candidate.enabled) {
    return 'unavailable'
  }

  if (candidate.state === 'cooling_off') {
    return 'cooling_off'
  }

  if (candidate.state === 'held') {
    return 'held'
  }

  return candidate.state === 'available' && candidate.secretId !== null
    ? 'available'
    : 'unavailable'
}

/** The groups, as one clause of a sentence: `alpha (1st choice), beta (2nd choice)`. */
const nameGroups = (groups: readonly SearchedGroup[]): string =>
  groups
    .map(
      (group) =>
        `${group.name} (position ${String(group.position)}${group.usable ? '' : ', disabled or archived'})`,
    )
    .join(', ')

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`

/** What the census found, as a clause: `2 held, 1 cooling off`. Empty when there is nothing. */
const nameCensus = (census: CredentialCensus): string =>
  [
    census.available === 0 ? undefined : `${String(census.available)} available`,
    census.held === 0 ? undefined : `${String(census.held)} held`,
    census.coolingOff === 0 ? undefined : `${String(census.coolingOff)} cooling off`,
    census.unavailable === 0 ? undefined : `${String(census.unavailable)} unhealthy or disabled`,
  ]
    .filter((part) => part !== undefined)
    .join(', ')

/**
 * Classify a census into the answer FR-029 asks for.
 *
 * Pure and separate from the query, so every one of the four cases — and the two that are not
 * waits at all — can be exercised without a database, and so the reasoning below is readable as a
 * decision rather than reconstructed from a `select`.
 *
 * The order of the branches is deliberate. The **structural** answers come first, because a run
 * that cannot reach a group is not competing for capacity and describing its situation in terms of
 * held or cooling-off credentials would be describing somebody else's pool. Then `available`,
 * because a census that found a selectable seat has not found exhaustion whatever else it found.
 * Only then the three "all X" cases, and finally `mixed` — which is a real and common state of a
 * small pool, and reporting it as one of the three would name a remedy that fixes only part of it.
 *
 * @param options.hasExecutionProfile - False for an ad-hoc run (002/FR-126).
 * @param options.groups - The attachments, in preference order.
 * @param options.census - The buckets, already counted.
 */
export const classifyWaitReason = (options: {
  readonly hasExecutionProfile: boolean
  readonly groups: readonly SearchedGroup[]
  readonly census: CredentialCensus
}): WaitReason => {
  const { census, groups } = options
  const named = nameGroups(groups)

  const answer = ((): { kind: WaitReasonKind; summary: string; remedy: string } => {
    if (!options.hasExecutionProfile) {
      return {
        kind: NO_EXECUTION_PROFILE,
        summary:
          'This run was launched without an execution profile, so it is attached to no agent-credential group and no group was searched.',
        remedy:
          'Relaunch it under an execution profile. Waiting cannot help: a credential is only reachable through a group the run’s profile is attached to, so no release by any other run can ever be granted to this one.',
      }
    }

    if (groups.length === 0) {
      return {
        kind: NO_GROUPS_ATTACHED,
        summary:
          'This run’s execution profile has no attached agent-credential groups, so there was nothing to search.',
        remedy:
          'Attach at least one credential group to the execution profile. This is a configuration fault rather than a queue: no release will ever be granted to a run that can reach no group.',
      }
    }

    if (census.total === 0) {
      return {
        kind: NO_CREDENTIALS,
        summary: `The agent-credential groups this run can reach hold no credentials at all. Groups searched, in preference order: ${named}.`,
        remedy:
          'Register a credential in one of those groups, or attach a group that has one. This is a configuration fault rather than a wait — nothing is going to be released, because nothing is held.',
      }
    }

    if (census.available > 0) {
      return {
        kind: SEAT_AVAILABLE,
        summary: `${plural(census.available, 'agent credential')} in this run’s groups ${census.available === 1 ? 'is' : 'are'} selectable right now. Groups searched, in preference order: ${named}.`,
        remedy:
          'Nothing. A seat was taken by another run between the selection and this report, or one has been released since; the next drain grants it.',
      }
    }

    if (census.held === census.total) {
      return {
        kind: 'all_held',
        summary: `Every agent credential this run can reach — ${plural(census.total, 'of them')} — is held by another run. Groups searched, in preference order: ${named}.`,
        remedy:
          'Wait for a run to finish, or register more credentials in these groups. The seat is granted automatically to the longest-waiting run that can reach it.',
      }
    }

    if (census.coolingOff === census.total) {
      return {
        kind: 'all_cooling_off',
        summary: `Every agent credential this run can reach — ${plural(census.total, 'of them')} — is cooling off against a provider usage or rate limit. Groups searched, in preference order: ${named}.`,
        remedy:
          'Wait. A provider limit clears without any administrator action, and the credential returns to the pool by itself.',
      }
    }

    if (census.unavailable === census.total) {
      return {
        kind: 'all_unhealthy_or_disabled',
        summary: `Every agent credential this run can reach — ${plural(census.total, 'of them')} — is unhealthy, disabled, or awaiting a login. Groups searched, in preference order: ${named}.`,
        remedy:
          'An administrator has to act: repair or re-log-in the broken credentials, or re-enable what was disabled. Waiting will not clear this on its own.',
      }
    }

    return {
      kind: 'mixed',
      summary: `No agent credential this run can reach is available: ${nameCensus(census)}. Groups searched, in preference order: ${named}.`,
      remedy:
        'Part of this clears on its own — cooling-off credentials return by themselves and held ones are released when their runs end — and part does not: an administrator has to repair or re-enable anything unhealthy or disabled.',
    }
  })()

  return {
    ...answer,
    configurationFault: CONFIGURATION_FAULT_KINDS.includes(answer.kind),
    grantable: answer.kind !== NO_EXECUTION_PROFILE,
    groups,
    census,
  }
}

/**
 * Why this workflow is waiting, over a live pool (FR-029).
 *
 * Called when selection returned nothing — by admission before it enters the waiting state, and by
 * the drain when it expires a wait — never on the path of a run that got a seat.
 *
 * @param reader - A database handle or an open transaction.
 * @param options - The workflow that found nothing. Nothing else, deliberately.
 * @returns The classification, the groups searched and the census behind it.
 * @throws If the workflow does not exist. A caller asking why an absent run is waiting has read it
 *   from somewhere this database does not agree with, and inventing a reason for it would put a
 *   sentence on a screen that describes nothing.
 */
export const describeWaitReason = async (
  reader: SelectionReader,
  options: DescribeWaitReasonOptions,
): Promise<WaitReason> => {
  const workflow = firstRow(
    await reader
      .select({ executionProfileId: workflows.executionProfileId })
      .from(workflows)
      .where(eq(workflows.id, options.workflowId))
      .limit(1),
  )

  if (workflow === undefined) {
    throw new Error(
      `Workflow ${options.workflowId} does not exist, so there is no wait to explain. A caller that read it from the queue and cannot find it now is looking at a different database.`,
    )
  }

  if (workflow.executionProfileId === null) {
    return classifyWaitReason({
      hasExecutionProfile: false,
      groups: [],
      census: { available: 0, held: 0, coolingOff: 0, unavailable: 0, total: 0 },
    })
  }

  // Out from the workflow, exactly as selection goes — so the groups this names are the groups that
  // were searched, and not a set assembled from a different starting point that happens to agree
  // most of the time. The credential join is a **left** join: a group holding nothing still has to
  // appear, because "these groups are empty" is the answer in the case that matters most.
  const rows = await reader
    .select({
      credentialGroupId: credentialGroups.id,
      credentialGroupName: credentialGroups.name,
      position: profileCredentialGroups.position,
      groupEnabled: credentialGroups.enabled,
      groupArchivedAt: credentialGroups.archivedAt,
      credentialId: agentCredentials.id,
      credentialState: agentCredentials.state,
      credentialEnabled: agentCredentials.enabled,
      secretId: agentCredentials.secretId,
    })
    .from(workflows)
    .innerJoin(
      profileCredentialGroups,
      eq(profileCredentialGroups.executionProfileId, workflows.executionProfileId),
    )
    .innerJoin(credentialGroups, eq(credentialGroups.id, profileCredentialGroups.credentialGroupId))
    .leftJoin(
      agentCredentials,
      and(
        eq(agentCredentials.credentialGroupId, credentialGroups.id),
        // In the join rather than the `where`, so an archived credential removes a row instead of
        // removing its group — the difference between "this group is empty" and "this group is not
        // attached", which are opposite diagnoses.
        isNull(agentCredentials.archivedAt),
      ),
    )
    .where(eq(workflows.id, options.workflowId))
    .orderBy(asc(profileCredentialGroups.position), asc(agentCredentials.id))

  const groups = new Map<string, SearchedGroup>()
  const counts = { available: 0, held: 0, coolingOff: 0, unavailable: 0, total: 0 }

  for (const row of rows) {
    const usable = row.groupEnabled && row.groupArchivedAt === null

    if (!groups.has(row.credentialGroupId)) {
      groups.set(row.credentialGroupId, {
        credentialGroupId: row.credentialGroupId,
        name: row.credentialGroupName,
        position: row.position,
        usable,
      })
    }

    if (
      row.credentialId === null ||
      row.credentialState === null ||
      row.credentialEnabled === null
    ) {
      // The left join's empty side: an attached group with no credential in it.
      continue
    }

    const bucket = bucketFor({
      groupUsable: usable,
      enabled: row.credentialEnabled,
      state: row.credentialState,
      secretId: row.secretId,
    })

    counts.total += 1
    if (bucket === 'available') counts.available += 1
    if (bucket === 'held') counts.held += 1
    if (bucket === 'cooling_off') counts.coolingOff += 1
    if (bucket === 'unavailable') counts.unavailable += 1
  }

  return classifyWaitReason({
    hasExecutionProfile: true,
    groups: [...groups.values()],
    census: counts,
  })
}
