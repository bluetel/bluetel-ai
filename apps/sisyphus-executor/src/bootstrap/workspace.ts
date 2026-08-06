/**
 * Bootstrap phase 6 — per-entry checkout into the pinned root (T055, T103).
 *
 * FR-112 says the agent must never start against a partial workspace. That is
 * easy to write as a comment and easy to lose: some later change reorders two
 * awaits, or a retry path calls `start` directly, and nothing fails until an
 * agent is confidently editing a directory that is missing half its code.
 *
 * So the ordering here is **structural rather than advisory**. A successful
 * checkout returns a {@link ReadyWorkspace} — a branded type whose only
 * construction site is {@link checkoutWorkspace}, exactly as `SanitisedText`
 * has only `createSanitiser`. Phase 7 (`agent-start.ts`) takes a
 * `ReadyWorkspace` and derives the agent's working directory from it. There is
 * therefore no way to express "start the agent" without holding the evidence
 * that every entry checked out: a half-built workspace does not type-check into
 * phase 7, and a partially-completed checkout never produces the value at all.
 *
 * ## Many entries (T103)
 *
 * The loop, the per-entry failure naming and the cleanup were written for many
 * entries from the start; T055 held them behind one explicit refusal in
 * {@link validateEntries}, and T103 removes it. What removing it *needed* was
 * the two things a second entry makes reachable and a first one cannot:
 *
 * - **Containment, not just collision.** Two entries at `api` and `api/web`
 *   have distinct subdirectories and still clobber one another — the second
 *   clone lands inside the first checkout, where it is neither a repository the
 *   agent can reason about nor removable without taking the first entry's work
 *   with it. `validateEntries` now refuses a nested pair as well as an
 *   identical one (FR-111), before any directory exists.
 * - **Cleanup that is checked.** With one entry there was nothing to unwind;
 *   with three, the second failing leaves the first on disk. The unwind is
 *   verified rather than hoped for: a removal that fails is reported alongside
 *   the entry that failed, because a silent residue turns the *next* attempt
 *   into "destination path already exists", which names the wrong problem.
 *
 * Every entry's resolved commit is handed to {@link CheckoutWorkspaceOptions.reportEntry}
 * as it lands, which is FR-114's record-at-checkout-time: a run that dies
 * mid-session has still recorded what each repository was pinned at, and a
 * report that fails fails the checkout rather than leaving an unrecorded entry.
 */

import { mkdir, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { BootstrapPhaseError, runPhase } from './phases'
import type { BootstrapPhaseReporter, RunPhaseContext } from './phases'
import { describeExit, runCommand } from './run-command'

/**
 * Fixed, because the agent derives its session directory from the absolute
 * working directory; an unpinned path makes a restored session unfindable
 * (R2, FR-051).
 */
export const PINNED_WORKSPACE_ROOT = '/workspace'

/** Relocated **inside** the root so the whole state tree is one tar target. */
export const AGENT_CONFIG_DIR_NAME = '.agent-config'

export const agentConfigDir = (root: string): string => join(root, AGENT_CONFIG_DIR_NAME)

/** One repository as the job envelope declares it (FR-109). */
export interface WorkspaceEntry {
  readonly entryId: string
  readonly repositoryUrl: string
  readonly baseBranch: string
  /** Beneath the workspace root, unique within the workspace (FR-111). */
  readonly subdirectory: string
  readonly isPrimary: boolean
}

/** One repository as it ended up on disk. */
export interface CheckedOutEntry {
  readonly entryId: string
  readonly subdirectory: string
  /** Absolute path, beneath the pinned root. */
  readonly path: string
  readonly baseBranch: string
  /** Recorded at checkout time, per FR-114. */
  readonly resolvedCommit: string
  readonly isPrimary: boolean
}

declare const readyWorkspaceBrand: unique symbol

/**
 * Evidence that **every** entry checked out.
 *
 * Unforgeable outside this module. That is the whole mechanism: hold one of
 * these and the workspace is complete, because there is no other way to obtain
 * one.
 */
export interface ReadyWorkspace {
  readonly [readyWorkspaceBrand]: 'workspace-checked-out'
  /** The pinned root; the agent's working directory (FR-113). */
  readonly root: string
  readonly configDir: string
  readonly entries: readonly CheckedOutEntry[]
  /** The entry whose `sisyphus-*` skills govern the run (FR-110). */
  readonly primary: CheckedOutEntry
}

export interface CheckoutWorkspaceOptions {
  readonly root: string
  readonly entries: readonly WorkspaceEntry[]
  readonly reporter: BootstrapPhaseReporter
  readonly timeoutMs?: number
  readonly now?: () => number
  /** Merged into git's environment — credential helpers, `GIT_*` settings. */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Where each entry's resolved commit goes as it lands (FR-114).
   *
   * Called inside the checkout, per entry, before the next one starts — so a
   * run that dies against its third repository has still recorded what the
   * first two were pinned at. A report that throws fails the checkout: an
   * entry on disk with no record of its commit is a workspace nobody can
   * reproduce, which is the thing the requirement is about.
   */
  readonly reportEntry?: (entry: CheckedOutEntry) => void | Promise<void>
  /**
   * How a directory is removed when the checkout unwinds. Injected only so the
   * cleanup path's own failure is testable; production passes nothing.
   */
  readonly remove?: (path: string) => Promise<void>
}

/**
 * Reject a subdirectory that collides or escapes (FR-111).
 *
 * Validation belongs at workspace configuration time too, but repeating it here
 * costs nothing and closes the gap where a stored configuration predates the
 * rule. An entry that escapes the root would also break the single-tar-target
 * invariant the whole snapshot design rests on (FR-051).
 */
export const resolveEntryPath = (root: string, entry: WorkspaceEntry): string => {
  const fail = (reason: string): never => {
    throw new BootstrapPhaseError('entry_checkout', `entry ${entry.entryId}: ${reason}`, {
      entryId: entry.entryId,
      retryable: false,
    })
  }

  if (entry.subdirectory.trim() === '') {
    return fail('its subdirectory is empty')
  }

  if (isAbsolute(entry.subdirectory)) {
    return fail(`its subdirectory "${entry.subdirectory}" is absolute, not beneath the root`)
  }

  const absolute = resolve(root, entry.subdirectory)
  const within = relative(resolve(root), absolute)

  if (within === '' || within.startsWith('..')) {
    return fail(`its subdirectory "${entry.subdirectory}" resolves outside the workspace root`)
  }

  return absolute
}

/** One entry and the absolute directory it was planned into. */
export interface PlannedEntry {
  readonly entry: WorkspaceEntry
  readonly path: string
}

/** Whether `child` lies beneath `parent`. Equal paths are not "beneath". */
const isBeneath = (parent: string, child: string): boolean => {
  const within = relative(parent, child)

  return within !== '' && !within.startsWith('..') && !isAbsolute(within)
}

/**
 * How two entries' directories overlap, or `undefined` when they do not.
 *
 * The nested case is the one only a multi-entry workspace can reach, and it is
 * worse than the identical case rather than milder: `api` and `api/web` look
 * like two distinct subdirectories right up until the second clone lands inside
 * the first checkout, where git sees a repository inside a repository, the
 * agent sees one tree, and unwinding either takes the other with it.
 */
const describeOverlap = (held: PlannedEntry, candidate: PlannedEntry): string | undefined => {
  if (held.path === candidate.path) {
    return (
      `entry ${candidate.entry.entryId}: subdirectory "${candidate.entry.subdirectory}" collides ` +
      `with entry ${held.entry.entryId} (FR-111)`
    )
  }

  if (isBeneath(held.path, candidate.path)) {
    return (
      `entry ${candidate.entry.entryId}: subdirectory "${candidate.entry.subdirectory}" is ` +
      `inside entry ${held.entry.entryId}'s "${held.entry.subdirectory}", so one checkout would ` +
      'land inside the other (FR-111)'
    )
  }

  if (isBeneath(candidate.path, held.path)) {
    return (
      `entry ${candidate.entry.entryId}: subdirectory "${candidate.entry.subdirectory}" ` +
      `contains entry ${held.entry.entryId}'s "${held.entry.subdirectory}", so one checkout ` +
      'would land inside the other (FR-111)'
    )
  }

  return undefined
}

/**
 * The shape rules that precede any filesystem work.
 *
 * Checked before anything is created, so a misconfigured workspace fails
 * without leaving a directory behind for the cleanup path to find. That
 * ordering is half of "no partial workspace": the failures that are decidable
 * from the configuration alone are decided while there is nothing to unwind.
 */
export const validateEntries = (
  root: string,
  entries: readonly WorkspaceEntry[],
): readonly PlannedEntry[] => {
  const fail = (reason: string, entryId?: string): never => {
    throw new BootstrapPhaseError('entry_checkout', reason, {
      ...(entryId === undefined ? {} : { entryId }),
      retryable: false,
    })
  }

  if (entries.length === 0) {
    return fail('the workspace declares no entries')
  }

  const primaries = entries.filter((entry) => entry.isPrimary)

  if (primaries.length !== 1) {
    return fail(
      `exactly one entry must be primary, and ${primaries.length} are (FR-110); the primary ` +
        "entry's skills govern the run, so there is no defensible way to pick one here",
    )
  }

  const resolved = entries.map((entry) => ({ entry, path: resolveEntryPath(root, entry) }))
  const claimed: PlannedEntry[] = []

  for (const candidate of resolved) {
    for (const held of claimed) {
      const overlap = describeOverlap(held, candidate)

      if (overlap !== undefined) {
        return fail(overlap, candidate.entry.entryId)
      }
    }

    claimed.push(candidate)
  }

  return resolved
}

/**
 * Create the pinned root and the relocated config directory.
 *
 * Called **before** phases 2–5, not as part of phase 6: `setup.sh` writes
 * credential material under `<root>/.agent-config/credentials/`, so the
 * directory it is promised in `SISYPHUS_AGENT_CONFIG_DIR` has to exist by the
 * time the bundle runs.
 */
export const prepareWorkspaceRoot = async (root: string): Promise<string> => {
  await mkdir(root, { recursive: true })

  const configDir = agentConfigDir(root)

  await mkdir(configDir, { recursive: true })

  return configDir
}

const git = async (
  entry: WorkspaceEntry,
  args: readonly string[],
  options: { readonly signal: AbortSignal; readonly env?: Readonly<Record<string, string>> },
): Promise<string> => {
  const result = await runCommand({
    command: 'git',
    args,
    signal: options.signal,
    ...(options.env === undefined ? {} : { env: options.env }),
  })

  if (result.exitCode !== 0) {
    throw new BootstrapPhaseError(
      'entry_checkout',
      `entry ${entry.entryId} (${entry.repositoryUrl} @ ${entry.baseBranch}): ` +
        `git ${args[0] ?? ''} ${describeExit(result)}. ${result.output.trim()}`.trim(),
      { entryId: entry.entryId },
    )
  }

  return result.output.trim()
}

/**
 * Clone one entry at its declared branch and record the resolved commit.
 *
 * Not a shallow clone. The agent reads history — blame, recent commits, the
 * conventions a repository's own log demonstrates — and a `--depth 1` checkout
 * makes all of that silently unavailable rather than visibly missing.
 */
export const checkoutEntry = async (
  entry: WorkspaceEntry,
  path: string,
  options: { readonly signal: AbortSignal; readonly env?: Readonly<Record<string, string>> },
): Promise<CheckedOutEntry> => {
  await git(
    entry,
    ['clone', '--branch', entry.baseBranch, '--single-branch', entry.repositoryUrl, path],
    options,
  )

  const resolvedCommit = await git(entry, ['-C', path, 'rev-parse', 'HEAD'], options)

  return {
    entryId: entry.entryId,
    subdirectory: entry.subdirectory,
    path,
    baseBranch: entry.baseBranch,
    resolvedCommit,
    isPrimary: entry.isPrimary,
  }
}

/** The default remover. Only the entry directories are ever passed to it. */
const removeDirectory = async (path: string): Promise<void> => {
  await rm(path, { recursive: true, force: true })
}

/**
 * Unwind the directories this checkout created, and say so if it could not.
 *
 * FR-112's "no partial workspace" is enforced twice over, and this is the
 * weaker half: the strong half is that {@link ReadyWorkspace} is never
 * constructed, so nothing downstream can be handed a half-built tree whatever
 * is left on disk. What the removal adds is that the *next* attempt on this
 * instance starts from nothing — and that is exactly why a removal failure
 * cannot be swallowed. A residue left quietly turns the retry's failure into
 * `destination path already exists`, which names the wrong entry for the wrong
 * reason and sends whoever reads it looking at git rather than at the disk.
 *
 * @param paths - Directories this call created, in creation order.
 * @param remove - How to remove one.
 * @returns The paths that could not be removed.
 */
const unwindCreated = async (
  paths: readonly string[],
  remove: (path: string) => Promise<void>,
): Promise<readonly string[]> => {
  const residue: string[] = []

  await Promise.all(
    paths.map(async (path) => {
      try {
        await remove(path)
      } catch {
        residue.push(path)
      }
    }),
  )

  return residue
}

/**
 * Phase 6, whole.
 *
 * Sequential rather than concurrent: entries share a filesystem and a git
 * credential helper, and "which entry failed" is the thing FR-112 requires the
 * failure to say. Concurrency would buy seconds and cost that.
 */
export const checkoutWorkspace = async (
  options: CheckoutWorkspaceOptions,
): Promise<ReadyWorkspace> => {
  const context: RunPhaseContext = {
    reporter: options.reporter,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  }

  return runPhase(
    'entry_checkout',
    async (signal): Promise<ReadyWorkspace> => {
      const planned = validateEntries(options.root, options.entries)
      const configDir = await prepareWorkspaceRoot(options.root)
      const created: string[] = []
      const checkedOut: CheckedOutEntry[] = []

      try {
        for (const { entry, path } of planned) {
          created.push(path)

          const checkout = await checkoutEntry(entry, path, {
            signal,
            ...(options.env === undefined ? {} : { env: options.env }),
          })

          // Recorded before the next entry is touched (FR-114). A run that
          // fails against its third repository has still recorded the commits
          // the first two were pinned at, which is what makes the failure
          // reproducible rather than merely reported.
          await options.reportEntry?.(checkout)
          checkedOut.push(checkout)
        }
      } catch (failure) {
        // No partial workspace (FR-112). Only the directories this call created
        // are removed — never the config tree, which `setup.sh` has already
        // populated with credentials by the time phase 6 runs.
        const residue = await unwindCreated(created, options.remove ?? removeDirectory)

        if (residue.length > 0) {
          const named = failure instanceof BootstrapPhaseError ? failure.entryId : undefined

          throw new BootstrapPhaseError(
            'entry_checkout',
            `${failure instanceof Error ? failure.message : String(failure)} — and the partial ` +
              `checkout could not be removed (${residue.join(', ')}), so this instance cannot be ` +
              'retried into a clean workspace',
            {
              ...(named === undefined ? {} : { entryId: named }),
              retryable: false,
              cause: failure,
            },
          )
        }

        throw failure
      }

      const primary = checkedOut.find((entry) => entry.isPrimary)

      if (primary === undefined) {
        throw new BootstrapPhaseError(
          'entry_checkout',
          'no primary entry survived checkout; the run has no skills source (FR-110)',
          { retryable: false },
        )
      }

      // The one construction site for the brand, and the only cast to it in
      // the codebase. Everything above must have succeeded to reach this line,
      // which is exactly what holding a `ReadyWorkspace` downstream asserts.
      // The double cast is the same trick `SanitisedText` uses: the brand has
      // no runtime representation, so the value cannot be built with it.
      return {
        root: options.root,
        configDir,
        entries: checkedOut,
        primary,
      } as unknown as ReadyWorkspace
    },
    context,
  )
}
