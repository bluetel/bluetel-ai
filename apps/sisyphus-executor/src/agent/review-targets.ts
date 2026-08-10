/**
 * **Which pull requests a review run is about (T196, FR-063, FR-080, FR-119).**
 *
 * `RunReviewWorkflowInput.targets` is required and nothing in the executor could produce one. This
 * is the gap that kept US5 unable to run even with a findings publisher in hand, and it is worth
 * stating exactly where it comes from, because the honest answer is a contract gap rather than a
 * missing function.
 *
 * ## The job envelope does not name a pull request
 *
 * `job-envelope.ts` carries the workspace, the job spec, the assembled prompt and nothing else. It
 * has no pull request number, no pull request URL and no ticket reference — the workflow row has a
 * ticket reference, the envelope does not carry it — and the machine surface exposes no procedure
 * to read one back. So the only place the target exists on this instance is inside
 * `prompt.assembled`, which is the engineer's own words ("review the PR on acme/api for ACME-142")
 * and is already in the conversation as the agent's opening prompt.
 *
 * ## So the agent is asked, and that is the same trust the delegated path already places
 *
 * This is not a new kind of authority. `createAgentDeveloperPort` asks the agent for `remote`,
 * `branchName` and `baseBranch`, and the delivery path pushes to whatever comes back — the
 * executor does not know a client's conventions and does not guess at them. Asking which pull
 * request the engineer meant is the same shape of question, answered from the same conversation.
 *
 * What is **not** the same is the blast radius of a wrong answer: findings posted on somebody
 * else's pull request are visible to the customer and cannot be taken back. So two things are checked
 * rather than trusted, and neither is optional:
 *
 * - **The entry id must be one of this run's.** The agent names a *workspace entry*, never a
 *   repository, and the repository is taken from the envelope's entry for it. There is therefore no
 *   string the agent could write that addresses a repository this run was not launched against.
 * - **The pull request must exist, and its URL comes from the host.** Every named target is read
 *   back through the forge; a number the host does not have halts the run, and the URL recorded
 *   against the workflow is the host's rather than the agent's. A plausible-looking URL invented
 *   here would be a link a reviewer follows to the wrong place.
 *
 * ## A review with no target does not become a review of everything
 *
 * An empty list halts. The obvious fallbacks — every open pull request in the workspace, the most
 * recent one — are both a run that posts findings on work nobody asked it to look at, which is
 * exactly the customer-visible irreversible act FR-080 is written about from the other direction.
 */

import { randomUUID } from 'node:crypto'

import type { ReviewTarget } from '../workflows'

import type { AgentAdapter } from './adapter'
import type { FrameTap } from './frame-tap'
import { answerMarkers } from './proposal-block'
import { askAgentForBlock } from './structured-turn'

/** Names the target block for a human reading the log. */
export const REVIEW_TARGETS_TAG = 'sisyphus-review-targets'

/** The step named in a halt, per FR-058. */
export const REVIEW_TARGET_STEP = 'review targets'

/** A backstop. Reading the prompt back is a question, not a piece of work. */
export const DEFAULT_TARGETS_DEADLINE_MS = 10 * 60_000

/** One workspace entry, as this module needs to see it. */
export interface ReviewTargetEntry {
  readonly entryId: string
  /** The repository reference from the envelope. Never the agent's (FR-109). */
  readonly repository: string
}

/** Reads one pull request back from the host. Structurally `delivery`'s `ReviewForge` method. */
export type PullRequestReader = (input: {
  readonly repository: string
  readonly pullRequestNumber: number
}) => Promise<{ readonly number: number; readonly url: string }>

export interface ResolveReviewTargetsOptions {
  /** The live conversation. Only `sendTurn`: this never starts or stops the agent. */
  readonly agent: Pick<AgentAdapter, 'sendTurn'>
  /** Frames as the run's own consumer pulls them; see `frame-tap.ts`. */
  readonly frames: Pick<FrameTap, 'subscribe'>
  /** Every entry of this run's workspace. The agent may name these and nothing else. */
  readonly entries: readonly ReviewTargetEntry[]
  readonly readPullRequest: PullRequestReader
  readonly deadlineMs?: number
  readonly settleMs?: number
  readonly turnTimeoutMs?: number
  /** Injected in tests, so a transcript can be written by hand. Random otherwise. */
  readonly nonce?: () => string
}

/** The halt for a review that could not establish what it is reviewing. */
export const reviewTargetError = (detail: string): Error =>
  new Error(
    `the ${REVIEW_TARGET_STEP} step could not establish which pull requests this review is ` +
      `about: ${detail}. Nothing was reviewed, no findings were posted and no ticket was moved — ` +
      'a review aimed at a pull request nobody named is a comment on somebody else’s work ' +
      '(FR-063, FR-080).',
  )

/** One target, as the agent is asked to name it. */
export const renderEntry = (entry: ReviewTargetEntry): string =>
  `- ${entry.repository} — workspace entry ${entry.entryId}`

/**
 * The turn.
 *
 * It states no repository of its own beyond the workspace's own list, asks for no reasoning, and is
 * explicit that a guess is worse than a refusal — because the failure mode here is an agent being
 * helpful about an ambiguous prompt.
 */
export const reviewTargetsTurnBody = (options: {
  readonly entries: readonly ReviewTargetEntry[]
  readonly nonce: string
}): string => {
  const { open, close } = answerMarkers(REVIEW_TARGETS_TAG, options.nonce)

  return [
    'Before reviewing anything: which pull requests is this review about?',
    '',
    'The answer is in the prompt this conversation opened with. Do not look for candidates, do ' +
      'not choose between them and do not infer one from the repository’s recent activity — read ' +
      'back the pull request the request named, and nothing else.',
    '',
    'This run’s workspace has these entries, and a target must belong to one of them:',
    '',
    ...options.entries.map(renderEntry),
    '',
    'Report by emitting exactly one block in this form, as ordinary assistant output:',
    '',
    open,
    '{ ... a single JSON object ... }',
    close,
    '',
    'The JSON object carries one key:',
    '',
    '- `targets`: a list, each with `entryId` (one of the workspace entry ids above) and ' +
      '`pullRequestNumber` (a whole number). Where the request names several pull requests, list ' +
      'all of them: they are reviewed together as one change and reach one verdict.',
    '',
    'If the prompt does not name a pull request, do not emit the block and say so. The run stops ' +
      'having reviewed nothing, which is the correct outcome — findings posted on a pull request ' +
      'nobody asked about cannot be taken back.',
  ].join('\n')
}

interface NamedTarget {
  readonly entryId: string
  readonly pullRequestNumber: number
}

/** Read the targets the block names, or say why they cannot be used. Nothing is inferred. */
const readNamedTargets = (
  value: Record<string, unknown>,
  entries: readonly ReviewTargetEntry[],
): { readonly targets?: readonly NamedTarget[]; readonly problems: readonly string[] } => {
  const raw = value['targets']
  const problems: string[] = []

  if (!Array.isArray(raw)) {
    return { problems: ['the block names no list of targets'] }
  }

  if (raw.length === 0) {
    return { problems: ['the block names an empty list of targets'] }
  }

  const known = new Set(entries.map((entry) => entry.entryId))
  const targets: NamedTarget[] = []

  for (const [index, candidate] of raw.entries()) {
    const where = `target ${String(index)}`

    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      problems.push(`${where} is not an object`)
      continue
    }

    const record = candidate as Record<string, unknown>
    const entryId = typeof record['entryId'] === 'string' ? record['entryId'].trim() : ''
    const number = record['pullRequestNumber']

    if (!known.has(entryId)) {
      // Named rather than dropped: a target outside the workspace is the agent having misread the
      // request, and continuing with the ones it got right would review half a change.
      problems.push(
        `${where} names workspace entry "${entryId}", which this run does not have ` +
          `(it has ${[...known].join(', ')})`,
      )
      continue
    }

    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
      problems.push(`${where} states a pull request number that is not a positive whole number`)
      continue
    }

    targets.push({ entryId, pullRequestNumber: number })
  }

  return problems.length > 0 ? { problems } : { targets, problems }
}

/**
 * Establish what a standalone review run is reviewing.
 *
 * @param options - The live conversation, this run's workspace entries, and the host reader.
 * @returns Every target, with its repository from the envelope and its URL from the host.
 * @throws When the agent named nothing, named something outside the workspace, or named a pull
 *   request the host does not have. Nothing partial is returned.
 */
export const resolveReviewTargets = async (
  options: ResolveReviewTargetsOptions,
): Promise<readonly ReviewTarget[]> => {
  const nonce = (options.nonce ?? ((): string => randomUUID()))()

  const answer = await askAgentForBlock({
    agent: options.agent,
    frames: options.frames,
    tag: REVIEW_TARGETS_TAG,
    nonce,
    body: reviewTargetsTurnBody({ entries: options.entries, nonce }),
    answerNoun: 'review target block',
    deadlineMs: options.deadlineMs ?? DEFAULT_TARGETS_DEADLINE_MS,
    ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
    ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
  })

  if (answer.kind === 'failed') {
    throw reviewTargetError(answer.detail)
  }

  const reading = readNamedTargets(answer.value, options.entries)

  if (reading.targets === undefined) {
    throw reviewTargetError(reading.problems.join('; '))
  }

  const resolved: ReviewTarget[] = []

  for (const named of reading.targets) {
    // Non-null by construction: `readNamedTargets` accepts only entry ids drawn from this list.
    const entry = options.entries.find((candidate) => candidate.entryId === named.entryId)

    if (entry === undefined) {
      throw reviewTargetError(`workspace entry ${named.entryId} disappeared while resolving`)
    }

    let seen: { readonly number: number; readonly url: string }

    try {
      seen = await options.readPullRequest({
        repository: entry.repository,
        pullRequestNumber: named.pullRequestNumber,
      })
    } catch (cause) {
      throw reviewTargetError(
        `${entry.repository}#${String(named.pullRequestNumber)} could not be read from the code ` +
          `host (${cause instanceof Error ? cause.message : String(cause)})`,
      )
    }

    resolved.push({
      entryId: entry.entryId,
      // The envelope's, never the agent's (FR-109).
      repository: entry.repository,
      pullRequestNumber: seen.number,
      // The host's, never the agent's: this is the link a reviewer follows.
      pullRequestUrl: seen.url,
    })
  }

  return resolved
}
