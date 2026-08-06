/**
 * Base-branch staleness (T070, FR-079, FR-114).
 *
 * ## What this does, and the one thing it must never do
 *
 * FR-079: if the base branch advances during a run such that the work is
 * stale, the staleness is **recorded on the workflow**, and **whether to
 * rebase is decided by the repository's skills rather than by Sisyphus**.
 *
 * That division is the whole design of the platform in miniature. Sisyphus
 * observes a fact about a client's repository and writes it down. The client's
 * repository — through its skills — decides what that fact means and what to
 * do about it, because it is the only party that knows whether this branch is
 * rebased, merged, or left alone until review. A helpful automatic rebase here
 * would be a defect, not a feature: it would rewrite history on a branch the
 * platform does not own, from a process nobody is watching, on the basis of a
 * convention it was never told.
 *
 * The prohibition is structural rather than remembered. This module's only
 * access to git is a {@link GitReader}, and every command a reader issues goes
 * through an allow-list that refuses `rebase`, `merge`, `reset`, `pull`,
 * `push` and everything else that could change a repository (see `./git.ts`).
 * There is no runner in this directory that would carry a rebase, so there is
 * no line in it that could be one. `staleness.test.ts` proves it against a real
 * repository: after a full assessment of a base branch that has advanced by
 * several commits, `HEAD`, the local branch, the tree and the working files are
 * byte-for-byte what they were.
 *
 * ## Per entry, and three states rather than two
 *
 * Staleness is evaluated **per workspace entry** (FR-114): a multi-repo run
 * can be current in one repository and forty commits behind in another, and a
 * single workflow-level flag would be a lie about both.
 *
 * The result is `current`, `stale` or `undetermined` — not a boolean. A base
 * branch that could not be read (deleted, renamed, or a remote that refused)
 * is not "current", and recording it as current is exactly the false assurance
 * a reviewer would act on. `undetermined` says the question was asked and not
 * answered, which is a different thing from the answer being no.
 */

import type { SegmentStore } from '../output'
import { sanitise } from '../output'
import type { MachineSurfaceClient } from '../report'

import type { GitReader } from './git'

export type StalenessState = 'current' | 'stale' | 'undetermined'

/**
 * Recorded on every assessment, and constant on purpose.
 *
 * It is the FR-079 division stated in the record itself: the panel, the
 * timeline and the reviewer all see that Sisyphus observed and deferred, and a
 * change to this value would be a change to a documented platform guarantee
 * rather than a quiet behavioural drift.
 */
export const REBASE_DECISION = 'deferred_to_repository_skills' as const

export interface StalenessCheck {
  /** The workflow entry this base branch belongs to (FR-114). */
  readonly entryId?: string
  readonly repository: string
  /** Remote to ask, named by the repository's skill. Never defaulted. */
  readonly remote: string
  /** Base branch, named by the repository's skill. Never defaulted. */
  readonly baseBranch: string
  /** The base tip recorded when this entry was checked out (FR-114). */
  readonly baseShaAtCheckout: string
  readonly git: GitReader
}

export interface StalenessAssessment {
  readonly entryId?: string
  readonly repository: string
  readonly baseBranch: string
  readonly baseShaAtCheckout: string
  /** What the remote has now, or `undefined` if it could not be read. */
  readonly baseShaNow?: string
  readonly state: StalenessState
  /** Commits the base gained, or `undefined` when the distance is unmeasured. */
  readonly commitsBehind?: number
  /** Prose for `workflow_entries.staleness_note`. */
  readonly note: string
  /** Always {@link REBASE_DECISION}. Sisyphus records; it does not act. */
  readonly rebaseDecision: typeof REBASE_DECISION
}

const fullRef = (branch: string): string =>
  branch.startsWith('refs/') ? branch : `refs/heads/${branch}`

const shortSha = (sha: string): string => sha.slice(0, 12)

const describeDistance = (commitsBehind: number | undefined): string =>
  commitsBehind === undefined
    ? 'by an unmeasured number of commits'
    : `by ${String(commitsBehind)} commit${commitsBehind === 1 ? '' : 's'}`

/**
 * Ask the remote where the base branch is now and compare it with checkout.
 *
 * Every call it makes is a question. Nothing it does can change the repository
 * it is looking at, the branch it is asking about, or the work in progress.
 *
 * @param check - The entry, its skill-named remote and base, and the sha recorded at checkout.
 * @returns The assessment, ready to record.
 */
export const assessStaleness = async (check: StalenessCheck): Promise<StalenessAssessment> => {
  const ref = fullRef(check.baseBranch)
  const baseShaNow = await check.git.remoteSha(check.remote, ref)
  const common = {
    ...(check.entryId === undefined ? {} : { entryId: check.entryId }),
    repository: check.repository,
    baseBranch: check.baseBranch,
    baseShaAtCheckout: check.baseShaAtCheckout,
    rebaseDecision: REBASE_DECISION,
  }

  if (baseShaNow === undefined) {
    return {
      ...common,
      state: 'undetermined',
      note:
        `The remote ${check.remote} did not report a commit for ${check.baseBranch}, so whether ` +
        'the base has advanced since checkout could not be determined.',
    }
  }

  if (baseShaNow === check.baseShaAtCheckout) {
    return {
      ...common,
      baseShaNow,
      state: 'current',
      commitsBehind: 0,
      note: `${check.baseBranch} is still at ${shortSha(baseShaNow)}, the commit this run checked out.`,
    }
  }

  // Populate the object store so the distance is measurable. `fetch` moves no
  // branch and touches no file; it is the only write on this whole path and it
  // writes to the object database alone.
  await check.git.fetchRef(check.remote, ref)

  const commitsBehind = await check.git.countCommitsBetween(check.baseShaAtCheckout, baseShaNow)

  return {
    ...common,
    baseShaNow,
    state: 'stale',
    ...(commitsBehind === undefined ? {} : { commitsBehind }),
    note:
      `${check.baseBranch} advanced from ${shortSha(check.baseShaAtCheckout)} to ` +
      `${shortSha(baseShaNow)} ${describeDistance(commitsBehind)} during this run. ` +
      "Whether to rebase is for the repository's skills to decide; Sisyphus has not changed the branch.",
  }
}

/**
 * Where an assessment is recorded.
 *
 * Narrow, and shaped to the machine surface's eventual per-entry reporting
 * rather than to today's transport, so nothing that assesses staleness depends
 * on how it is stored.
 */
export interface StalenessRecorder {
  readonly record: (assessment: StalenessAssessment) => Promise<void>
}

export interface ArtifactStalenessRecorderOptions {
  readonly workflowId: string
  readonly client: Pick<MachineSurfaceClient, 'registerArtifact'>
  readonly store: SegmentStore
  readonly keyPrefix?: string
}

/**
 * Record the assessment as a stored `report` artifact against the workflow.
 *
 * `workflow_entries.staleness_note` is written by the machine surface's
 * per-entry reporting, which lands later (api-surface.md → `reportEntryResult`).
 * Until then this puts the same fact on the workflow through the surface that
 * exists, behind {@link StalenessRecorder} so the swap is one adapter.
 *
 * The body is stored before the row naming it is reported, for the same reason
 * log segments are.
 */
export const createArtifactStalenessRecorder = (
  options: ArtifactStalenessRecorderOptions,
): StalenessRecorder => {
  const keyPrefix = options.keyPrefix ?? `workflows/${options.workflowId}`

  return {
    record: async (assessment) => {
      const key = `${keyPrefix}/entries/${assessment.entryId ?? 'primary'}/staleness.json`
      // Machine-authored — shas, branch names and this module's own prose — so
      // sanitising is very nearly a no-op. It still goes through the sanitiser
      // rather than being cast, because the branded type has exactly one
      // construction site and an exception made here is an exception made.
      const body = sanitise(`${JSON.stringify(assessment, null, 2)}\n`)

      await options.store.put({ key, body })
      await options.client.registerArtifact({
        kind: 'report',
        s3Key: key,
        byteSize: new TextEncoder().encode(body).length,
        ...(assessment.entryId === undefined ? {} : { entryId: assessment.entryId }),
      })
    },
  }
}

/**
 * Assess and record in one call.
 *
 * There is deliberately no third step. Whatever the assessment says, the run
 * continues and the branch is untouched (FR-079).
 *
 * @param recorder - Where the assessment is recorded.
 * @param check - The entry and its skill-named base branch.
 * @returns The recorded assessment.
 */
export const recordStaleness = async (
  recorder: StalenessRecorder,
  check: StalenessCheck,
): Promise<StalenessAssessment> => {
  const assessment = await assessStaleness(check)

  await recorder.record(assessment)

  return assessment
}
