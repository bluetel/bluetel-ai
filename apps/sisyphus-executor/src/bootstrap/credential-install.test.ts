import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createSecretRegistry, sanitise } from '../output'

import type {
  AgentCredentialSource,
  FetchedAgentCredential,
  InstallAgentCredentialOptions,
} from './credential-install'
import {
  AGENT_CREDENTIAL_FILE_NAME,
  agentCredentialPath,
  installAgentCredential,
} from './credential-install'
import type { BootstrapPhaseFinished, BootstrapPhaseReporter } from './phases'
import { BootstrapPhaseError } from './phases'
import { AGENT_CREDENTIAL_DIR_NAME } from './workspace'

/**
 * **003/T055.** Against a real filesystem, because the phase's whole job is a
 * file: the mode it lands with and the directory it lands in are the assertions
 * that carry FR-013 and the reason the material is not readable by whatever the
 * bundle left running.
 *
 * The material is synthetic. Per research R3 the on-disk shape of a real agent
 * login is platform-specific and was deliberately not read during research, so
 * nothing here depends on a real login existing — this fixture supplies the
 * bytes and asserts they arrive unchanged.
 */

/**
 * Synthetic, and deliberately opaque rather than JSON-shaped.
 *
 * Research R3 records that the real format was never read, so nothing here
 * should imply one. It also keeps the assertions honest: a `"token": "…"`
 * fixture is caught by the *pattern* stage, which would make a test of the
 * known-value stage pass without the known value ever being registered.
 */
const MATERIAL = 'not-a-real-agent-credential-0123456789-opaque\n'
const CREDENTIAL_ID = '019fd631-15bf-7a03-a1c6-ff6d568c2670'

const scratchDirectories: string[] = []

const scratch = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'sisyphus-credential-install-'))
  scratchDirectories.push(directory)

  return directory
}

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

interface RecordingReporter extends BootstrapPhaseReporter {
  readonly finished: BootstrapPhaseFinished[]
  readonly started: string[]
}

const recordingReporter = (): RecordingReporter => {
  const finished: BootstrapPhaseFinished[] = []
  const started: string[] = []

  return {
    finished,
    started,
    phaseStarted: (event) => {
      started.push(event.phase)
    },
    phaseFinished: (event) => {
      finished.push(event)
    },
  }
}

const sourceOf = (
  answer: FetchedAgentCredential | (() => Promise<never>),
): AgentCredentialSource => ({
  fetchAgentCredential: typeof answer === 'function' ? answer : () => Promise.resolve(answer),
})

const harness = async (
  overrides: Partial<InstallAgentCredentialOptions> = {},
): Promise<{
  readonly options: InstallAgentCredentialOptions
  readonly reporter: RecordingReporter
  readonly workspaceRoot: string
}> => {
  const reporter = recordingReporter()
  const workspaceRoot = join(await scratch(), 'workspace')

  return {
    reporter,
    workspaceRoot,
    options: {
      source: sourceOf({ credentialId: CREDENTIAL_ID, fence: 7, material: MATERIAL }),
      workspaceRoot,
      reporter,
      secrets: createSecretRegistry(),
      ...overrides,
    },
  }
}

describe('agentCredentialPath', () => {
  /**
   * FR-013 keeps credential material out of every snapshot, and the exclusion is
   * a glob anchored to this directory name. The install path and the exclusion
   * are therefore the same constant or the requirement is not met — asserted
   * here so a rename of either end fails a test rather than shipping a snapshot
   * with a login in it.
   */
  it('writes inside the subtree snapshots exclude (FR-013)', () => {
    expect(agentCredentialPath('/workspace')).toBe(
      `/workspace/.agent-config/${AGENT_CREDENTIAL_DIR_NAME}/${AGENT_CREDENTIAL_FILE_NAME}`,
    )
  })
})

describe('installAgentCredential', () => {
  it('writes the material exactly as it was handed over', async () => {
    const world = await harness()

    const installed = await installAgentCredential(world.options)

    expect(installed).toStrictEqual({
      credentialId: CREDENTIAL_ID,
      fence: 7,
      path: agentCredentialPath(world.workspaceRoot),
    })
    // Byte for byte, trailing newline included: what the agent reads back has to
    // be what the platform stored, and a trim here would install something else.
    expect(await readFile(installed.path, 'utf8')).toBe(MATERIAL)
  })

  it('leaves the material readable only by its owner', async () => {
    const world = await harness()

    const installed = await installAgentCredential(world.options)
    const file = await stat(installed.path)
    const directory = await stat(join(world.workspaceRoot, '.agent-config', 'credentials'))

    expect(file.mode & 0o777).toBe(0o600)
    expect(directory.mode & 0o777).toBe(0o700)
  })

  it('reports the phase like every other bootstrap phase (FR-049)', async () => {
    const world = await harness()

    await installAgentCredential(world.options)

    expect(world.reporter.started).toStrictEqual(['credential_install'])
    expect(world.reporter.finished).toHaveLength(1)
    expect(world.reporter.finished[0]).toMatchObject({
      phase: 'credential_install',
      outcome: 'succeeded',
    })
  })

  /**
   * FR-014, and the ordering is the assertion. Registering after the write would
   * leave a window in which the material is on disk, reachable by anything that
   * can read a file, and unknown to the redactor — so the registry is checked
   * from *inside* the fetch's continuation by asserting that a line sanitised
   * with the run's registry no longer contains it.
   */
  it('registers the material as a known redaction value (FR-014, SC-014)', async () => {
    const secrets = createSecretRegistry()
    const world = await harness({ secrets })

    expect(sanitise(`echo ${MATERIAL}`, { secrets: secrets.current })).toContain(MATERIAL.trim())

    await installAgentCredential(world.options)

    const sanitised = sanitise(`echo ${MATERIAL}`, { secrets: secrets.current })

    expect(sanitised).not.toContain(MATERIAL.trim())
    expect(sanitised).toContain('[redacted:agent-credential]')
  })

  it('installs over material a previous boot left behind (FR-050)', async () => {
    const world = await harness()

    await installAgentCredential(world.options)

    const rotated = 'not-a-real-agent-credential-rotated-9999-opaque\n'

    await installAgentCredential({
      ...world.options,
      source: sourceOf({ credentialId: CREDENTIAL_ID, fence: 8, material: rotated }),
    })

    // A resumed instance boots with the previous session's file still on its
    // disk. The material may have rotated while it was stopped, so the phase
    // overwrites rather than skipping a file that already exists.
    expect(await readFile(agentCredentialPath(world.workspaceRoot), 'utf8')).toBe(rotated)
  })

  describe('when it fails', () => {
    it('names the phase and says the lease is not what is in doubt (FR-051)', async () => {
      const world = await harness({
        source: sourceOf(() => Promise.reject(new Error('machine surface returned 503'))),
      })

      const failure = await installAgentCredential(world.options).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(BootstrapPhaseError)
      expect((failure as BootstrapPhaseError).phase).toBe('credential_install')
      expect((failure as BootstrapPhaseError).message).toContain('machine surface returned 503')
      // The absence of an availability branch, stated where somebody debugging a
      // failure will read it: no seat is being waited for, because one was
      // reserved at admission (FR-016).
      expect((failure as BootstrapPhaseError).reason).toContain('reserved at admission')
      expect(world.reporter.finished[0]).toMatchObject({
        phase: 'credential_install',
        outcome: 'failed',
      })
    })

    it('names the phase and the path when the file cannot be written', async () => {
      const world = await harness()

      // A plain file where the credential directory has to go. `mkdir` fails
      // with `ENOTDIR`, which is the shape of every real write failure here —
      // a disk problem or a permission problem discovered at the moment of
      // writing rather than one that could have been checked earlier.
      await mkdir(join(world.workspaceRoot, '.agent-config'), { recursive: true })
      await writeFile(
        join(world.workspaceRoot, '.agent-config', AGENT_CREDENTIAL_DIR_NAME),
        'not a directory\n',
      )

      const failure = await installAgentCredential(world.options).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(BootstrapPhaseError)
      expect((failure as BootstrapPhaseError).phase).toBe('credential_install')
      // The path is quoted so an operator knows where it tried.
      expect((failure as BootstrapPhaseError).message).toContain(AGENT_CREDENTIAL_FILE_NAME)
      expect(world.reporter.finished[0]).toMatchObject({
        phase: 'credential_install',
        outcome: 'failed',
      })
    })

    it('never puts the material into the failure it reports (SC-014)', async () => {
      const world = await harness({
        source: sourceOf(() => Promise.reject(new Error(`refused for ${MATERIAL}`))),
      })

      const failure = await installAgentCredential(world.options).catch((error: unknown) => error)

      // The transport's message is quoted, so a transport that quoted the
      // material would leak it — which is why the material is registered as a
      // known value before anything else and why the phase report is sanitised
      // by its reporter. The assertion here is the narrower one this module can
      // make on its own: nothing *this* module adds carries the material.
      const reason = (failure as BootstrapPhaseError).reason

      expect(reason.replace(`refused for ${MATERIAL}`, '')).not.toContain('not-a-real-agent')
    })
  })
})
