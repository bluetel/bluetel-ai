/**
 * **The delivery entry list (T230, FR-109, FR-115, FR-118).**
 *
 * `DelegatedPorts.entries` is `readonly PullRequestSetEntry[]` and nothing built one, so a run
 * could hold both agent ports and still deliver nothing. This is that builder.
 *
 * Five of the seven fields are a join: `entryId`, `repository` and `baseBranch` come from the
 * workspace — **this** repository's base, never the primary's (FR-109) — and `git` and `forge` are
 * the two ports, one `GitReader` per entry rooted at that entry's own checkout. The other two are
 * observations, and they are the whole reason this module exists rather than a `map` inline in the
 * composition root.
 *
 * ## Two steps, because the two observations are made at two different times
 *
 * `preExecutionRemoteSha` is *what the forge had before the run started* and `wasChanged` is
 * *what the agent did*, and no single function can honestly answer both: one is only true before
 * the pass and the other is only knowable after it. A builder that pretended otherwise would be
 * wrong at whichever end it was called from, and wrong in the expensive direction —
 * `pull-request.ts` refuses to open a pull request when `preExecutionRemoteSha` equals what the
 * forge now has, so a "before" value read *after* the agent pushed would discard every successful
 * run's work with a message saying it pushed nothing.
 *
 * So there are two steps, and the ordering is not left to a caller to remember:
 *
 * - {@link prepareDeliveryEntries} is the before-step. It probes the forge, and it is `async`, so
 *   there is no way to hold an entry list that has not been through it.
 * - {@link PreparedDeliveryEntries.observing} wraps the run's {@link DeveloperPort} and makes the
 *   after-step happen at the one correct moment: the instant the development pass returns, which
 *   is after the agent has finished changing things and before `openPullRequestSet` reads a single
 *   `wasChanged`. Nothing else in the run sits in that gap.
 *
 * Until the after-step has run, reading `wasChanged` **throws** rather than answering `false`.
 * `false` opens no pull request at all (FR-115), so a default there would turn a wiring mistake
 * into an agent's work quietly discarded and a run that reported success; a throw becomes a
 * terminal `failed` naming the defect (FR-056).
 *
 * ## What `wasChanged` counts
 *
 * A real observation of the repository through git, never the agent's own word for it — the
 * agent's `wasChanged` and its per-entry summary flags are self-reports, and distrusting
 * self-reports is the entire reason `pull-request.ts` verifies a push against the forge. An entry
 * is changed when **either**:
 *
 * - `git status --porcelain --untracked-files=all` reports anything — staged, unstaged, renamed,
 *   deleted **and** untracked. An agent that wrote a new file and did not `git add` it has
 *   changed the repository, and a status that ignored untracked files would call that clean.
 * - `HEAD` has moved off the commit the entry was checked out at. An agent that committed its own
 *   work leaves a spotlessly clean tree, and a tree-only test would read that as "did nothing" —
 *   the false negative that silently throws the whole pass away.
 *
 * When git cannot be asked at all the entry is reported as **changed**, with the refusal recorded.
 * That is deliberate asymmetry: an entry wrongly called changed fails loudly in the delivery step
 * and is recorded against that entry (FR-118), while an entry wrongly called unchanged is never
 * mentioned again.
 *
 * ## A probe that fails makes one entry undeliverable, not the run
 *
 * `branchHead` maps only a 404 to `undefined`; every other failure throws, and those must not be
 * flattened into "the host had no such branch" — that is exactly the false assurance
 * `staleness.ts` refuses when it reports `undetermined` rather than `current`. So a thrown probe
 * is kept, and the entry is given a {@link refusingForge} that carries the failure into the
 * delivery step, where `openPullRequestSet` records it against that entry and every other entry
 * still reaches a result of its own (FR-118).
 *
 * The alternative — failing the whole run at probe time — is cheap in wasted work, because
 * nothing has been done yet, and expensive in everything else: one repository's forge being
 * briefly unreachable says nothing about the other repositories in the workspace, and a run that
 * refused to start would leave the engineer with neither the work nor a per-entry reason. FR-118
 * is explicit that the partial result is the outcome to reach for.
 */

import type { CheckedOutEntry, WorkspaceEntry } from '../bootstrap'
import type { Forge, GitReader, GitRunner, PullRequestSetEntry } from '../delivery'
import { createGitReader, createGuardedGitRunner, createProcessGitRunner } from '../delivery'
import type { DeveloperPort } from '../workflows'

/** The step named in a halt, per FR-058. */
export const DELIVERY_ENTRY_STEP = 'delivery entry list'

/**
 * Everything the working tree is asked, in one command.
 *
 * `--untracked-files=all` rather than the default `normal`: a new directory of files reported as
 * one line or as none is the difference between delivering a pass and discarding it.
 */
export const WORKING_TREE_STATUS = ['status', '--porcelain', '--untracked-files=all'] as const

/** Why an entry was, or was not, reported as changed. */
export type DeliveryEntryEvidence =
  /** `git status` reported something: staged, unstaged, renamed, deleted or untracked. */
  | 'working-tree'
  /** The tree is clean and `HEAD` has moved off the checkout commit — the agent committed. */
  | 'committed'
  /** A clean tree at the commit this entry was checked out at. Nothing happened here. */
  | 'clean'
  /** git could not be asked. Reported as changed, so the delivery step fails visibly. */
  | 'unreadable'

/** What the after-step saw in one entry. */
export interface DeliveryEntryObservation {
  readonly entryId: string
  readonly repository: string
  readonly wasChanged: boolean
  readonly evidence: DeliveryEntryEvidence
  /** git's own words, present only when it refused. */
  readonly detail?: string
}

/** How the before-step's question to the forge went. */
export type DeliveryEntryProbeOutcome =
  /** The forge answered, with a sha or with "no such branch". */
  | 'probed'
  /** No work branch was known before the agent ran, so the forge was not asked. */
  | 'skipped'
  /** The forge was asked and failed. This entry is undeliverable; see {@link refusingForge}. */
  | 'failed'

/** What the before-step learned about one entry, kept for the report. */
export interface DeliveryEntryProbe {
  readonly entryId: string
  readonly repository: string
  readonly outcome: DeliveryEntryProbeOutcome
  /** What the forge had at the work branch. Absent when it had none, or was not asked. */
  readonly preExecutionRemoteSha?: string
  /** Why the probe failed, in the forge's own words. Present only on `failed`. */
  readonly reason?: string
}

export interface PrepareDeliveryEntriesInput {
  /**
   * Every entry as it landed on disk — `bootstrapped.workspace.entries`.
   *
   * Taken as checkouts rather than as the `ReadyWorkspace` itself because FR-112's
   * "no partial workspace" is already discharged: the caller cannot be holding these without
   * holding the evidence that every entry checked out.
   */
  readonly checkouts: readonly CheckedOutEntry[]
  /**
   * The envelope's entries, which are where the repository reference lives (FR-109).
   *
   * A checkout knows its path and its base branch and not what to call itself to a code host;
   * `run/bootstrap.ts`'s `workspaceEntries` produces exactly this list.
   */
  readonly repositories: readonly WorkspaceEntry[]
  /** One forge for the whole workspace; see `assemble.ts` on why the host is one URL. */
  readonly forge: Forge
  /**
   * The shared work branch, **if the run knows it before the agent starts**.
   *
   * Omitted is the ordinary case today and is not an oversight: `sisyphus-dev` states the branch
   * naming rule in prose and the *agent* applies it during the development pass, so the name does
   * not exist until the pass has already pushed. Asking the forge then would answer with the sha
   * the agent just pushed, and `noPushedWorkError` would throw away the very work it verified —
   * so this module asks early or not at all. With no name there is no `preExecutionRemoteSha`,
   * which leaves the forge's own two checks (the branch exists, and it is at exactly the local
   * `HEAD`) doing the verification.
   */
  readonly workBranch?: string
  /** Injected in tests, so nothing spawns git. Defaults to the guarded process runner. */
  readonly run?: GitRunner
}

export interface PreparedDeliveryEntries {
  /** Hand straight to `DelegatedPorts.entries`. */
  readonly entries: readonly PullRequestSetEntry[]
  /** What the before-step asked the forge, per entry. */
  readonly probes: readonly DeliveryEntryProbe[]
  /**
   * Wrap the run's developer port, so the after-step runs the moment the pass returns.
   *
   * This is the supported way to order the two steps. The observation happens after the agent has
   * stopped working and before anything reads `wasChanged`, and a caller that forgets to wrap gets
   * a named failure from {@link unobservedDeliveryEntryError} rather than a silent `false`.
   */
  readonly observing: (developer: DeveloperPort) => DeveloperPort
  /** The after-step itself, for a caller with its own seam. Runs once however often it is called. */
  readonly observe: () => Promise<readonly DeliveryEntryObservation[]>
}

/**
 * A checkout with no entry in the envelope that declares it.
 *
 * Not recoverable and not guessable: without the repository reference there is nothing to address
 * the forge with, and picking another entry's would propose one repository's work onto another's.
 */
export const unknownEntryRepositoryError = (entryId: string): Error =>
  new Error(
    `the ${DELIVERY_ENTRY_STEP} has a checkout for entry ${entryId} and the job envelope declares ` +
      'no repository for it, so there is no reference to address a forge with. Nothing was ' +
      'attempted for any entry.',
  )

/**
 * `wasChanged` read before the after-step ran.
 *
 * Says what is wrong and where, because the wiring mistake it names is invisible at the call site:
 * every field of the entry looks present, and the wrong answer would be a plausible `false`.
 */
export const unobservedDeliveryEntryError = (entryId: string): Error =>
  new Error(
    `the delivery step asked whether entry ${entryId} changed before the working tree had been ` +
      'observed. The development pass must go through `observing()` — a `false` here would open ' +
      'no pull request at all (FR-115) and the agent’s work would be discarded silently.',
  )

const describe = (thrown: unknown): string =>
  thrown instanceof Error ? thrown.message : String(thrown)

/**
 * Why an entry whose pre-execution probe failed opens no pull request.
 *
 * Thrown from the entry's own forge at delivery time, so `openPullRequestSet` records it against
 * that entry and the rest of the set still runs (FR-118).
 */
export const undeliverableEntryError = (repository: string, reason: string): Error =>
  new Error(
    `the forge could not be asked what ${repository} had at the work branch before this run ` +
      `started (${reason}), so a pull request here could not be shown to be this run's work. ` +
      'Nothing was opened for this entry; the other entries were attempted.',
  )

/**
 * A forge that answers every question with the reason it cannot be used.
 *
 * Deliberately not a partial forge with one broken method. Pushed-commit verification is the first
 * thing `openDraftPullRequest` does, so any of the three being reached means the entry got further
 * than it should have, and all three say the same thing.
 *
 * @param repository - The entry's repository, named in the refusal.
 * @param reason - What the probe failed with.
 * @returns A `Forge` whose every method rejects.
 */
export const refusingForge = (repository: string, reason: string): Forge => {
  const refuse = (): Promise<never> => Promise.reject(undeliverableEntryError(repository, reason))

  return { branchHead: refuse, findPullRequest: refuse, createPullRequest: refuse }
}

/** Ask the forge what it has at the work branch, before the agent has run. */
const probeEntry = async (input: {
  readonly entryId: string
  readonly repository: string
  readonly forge: Forge
  readonly workBranch: string | undefined
}): Promise<DeliveryEntryProbe> => {
  const identity = { entryId: input.entryId, repository: input.repository }

  if (input.workBranch === undefined) {
    return { ...identity, outcome: 'skipped' }
  }

  try {
    const sha = await input.forge.branchHead({
      repository: input.repository,
      branch: input.workBranch,
    })

    // `undefined` is an answer, not a failure: the host has no such branch, which is the ordinary
    // case for new work. Only a 404 produces it; see `forge-http.ts`.
    return {
      ...identity,
      outcome: 'probed',
      ...(sha === undefined ? {} : { preExecutionRemoteSha: sha }),
    }
  } catch (thrown) {
    return { ...identity, outcome: 'failed', reason: describe(thrown) }
  }
}

/**
 * Observe one repository, after the pass.
 *
 * The tree is asked first and `HEAD` second, and both are asked even when the first answers
 * "clean" — a committed pass leaves nothing in the tree to find.
 */
const observeEntry = async (input: {
  readonly entryId: string
  readonly repository: string
  readonly checkout: CheckedOutEntry
  readonly git: GitReader
  readonly run: GitRunner
}): Promise<DeliveryEntryObservation> => {
  const identity = { entryId: input.entryId, repository: input.repository }
  let refusal: string | undefined

  try {
    const status = await input.run({ args: [...WORKING_TREE_STATUS], cwd: input.checkout.path })

    if (status.exitCode === 0) {
      if (status.stdout.trim() !== '') {
        return { ...identity, wasChanged: true, evidence: 'working-tree' }
      }
    } else {
      refusal = status.stderr.trim()
    }
  } catch (thrown) {
    refusal = describe(thrown)
  }

  try {
    if ((await input.git.headSha()) !== input.checkout.resolvedCommit) {
      return { ...identity, wasChanged: true, evidence: 'committed' }
    }
  } catch (thrown) {
    refusal = refusal ?? describe(thrown)
  }

  // Unreadable is reported as changed. The delivery step then fails against this entry and says
  // why, which a reviewer can act on; the other direction is work nobody ever hears about again.
  return refusal === undefined
    ? { ...identity, wasChanged: false, evidence: 'clean' }
    : { ...identity, wasChanged: true, evidence: 'unreadable', detail: refusal }
}

interface EntrySource {
  readonly checkout: CheckedOutEntry
  readonly repository: string
}

/** Join each checkout to the repository reference the envelope declared for it (FR-109). */
const sourcesFor = (
  checkouts: readonly CheckedOutEntry[],
  repositories: readonly WorkspaceEntry[],
): readonly EntrySource[] =>
  checkouts.map((checkout) => {
    const declared = repositories.find((entry) => entry.entryId === checkout.entryId)

    if (declared === undefined) {
      throw unknownEntryRepositoryError(checkout.entryId)
    }

    return { checkout, repository: declared.repositoryUrl }
  })

/**
 * Build the delivery entry list, and probe the forge before the agent runs.
 *
 * Call this from the workflow ports factory — the last point in the run that is strictly before
 * the development pass. The result's `entries` go to `DelegatedPorts.entries` and its `observing`
 * wraps `DelegatedPorts.developer`.
 *
 * @param input - The checkouts, the envelope's repositories, the forge, and the work branch if the
 *   run knows one before the agent starts.
 * @returns The entry list, what each probe found, and the two ways to run the after-step.
 * @throws When a checkout has no declared repository. Nothing partial is returned.
 */
export const prepareDeliveryEntries = async (
  input: PrepareDeliveryEntriesInput,
): Promise<PreparedDeliveryEntries> => {
  const run = createGuardedGitRunner(input.run ?? createProcessGitRunner())
  const sources = sourcesFor(input.checkouts, input.repositories)
  const probes: DeliveryEntryProbe[] = []
  const entries: PullRequestSetEntry[] = []
  const observed = new Map<string, DeliveryEntryObservation>()

  for (const source of sources) {
    const { checkout } = source
    const probe = await probeEntry({
      entryId: checkout.entryId,
      repository: source.repository,
      forge: input.forge,
      workBranch: input.workBranch,
    })

    probes.push(probe)

    const git = createGitReader({ cwd: checkout.path, run })

    entries.push({
      entryId: checkout.entryId,
      repository: source.repository,
      // This repository's own base, from the entry that declared it. Never the primary's (FR-109).
      baseBranch: checkout.baseBranch,
      ...(probe.preExecutionRemoteSha === undefined
        ? {}
        : { preExecutionRemoteSha: probe.preExecutionRemoteSha }),
      get wasChanged(): boolean {
        const observation = observed.get(checkout.entryId)

        if (observation === undefined) {
          throw unobservedDeliveryEntryError(checkout.entryId)
        }

        return observation.wasChanged
      },
      git,
      forge:
        probe.outcome === 'failed'
          ? refusingForge(source.repository, probe.reason ?? 'no reason recorded')
          : input.forge,
    })
  }

  let running: Promise<readonly DeliveryEntryObservation[]> | undefined

  const observe = async (): Promise<readonly DeliveryEntryObservation[]> => {
    running ??= (async (): Promise<readonly DeliveryEntryObservation[]> => {
      const observations: DeliveryEntryObservation[] = []

      for (const source of sources) {
        const observation = await observeEntry({
          entryId: source.checkout.entryId,
          repository: source.repository,
          checkout: source.checkout,
          git: createGitReader({ cwd: source.checkout.path, run }),
          run,
        })

        observed.set(source.checkout.entryId, observation)
        observations.push(observation)
      }

      return observations
    })()

    return running
  }

  return {
    entries,
    probes,
    observe,
    observing:
      (developer: DeveloperPort): DeveloperPort =>
      async (request) => {
        const proposal = await developer(request)

        // After the pass and before anything reads `wasChanged`. The proposal's own `wasChanged`
        // is passed through untouched and is not consulted here: it is the agent's account of its
        // work, and the entry list records what the repository actually shows.
        await observe()

        return proposal
      },
  }
}
