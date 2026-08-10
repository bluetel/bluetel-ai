/* cspell:ignore AKIAIOSFODNN EXAMPLEKEY */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createFakeArchiveStore } from './archive-store'
import {
  assertSetupScript,
  runBundleBootstrap,
  SETUP_SCRIPT_IDEMPOTENCY_NOTE,
  sha256Hex,
  verifyArchiveDigest,
  type SetupBundleReference,
} from './bundle'
import { BootstrapPhaseError, nullPhaseReporter } from './phases'
import type { BootstrapPhaseFinished, BootstrapPhaseReporter } from './phases'
import { runCommand } from './run-command'

const scratchDirectories: string[] = []

const scratch = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'sisyphus-bundle-'))

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
}

const recordingReporter = (): RecordingReporter => {
  const finished: BootstrapPhaseFinished[] = []

  return {
    finished,
    phaseStarted: () => undefined,
    phaseFinished: (event) => {
      finished.push(event)
    },
  }
}

/** Build a real gzipped tar with real `tar`, since that is what production unpacks. */
const buildArchive = async (files: Readonly<Record<string, { body: string; mode: number }>>) => {
  const source = await scratch()

  for (const [name, file] of Object.entries(files)) {
    const path = join(source, name)

    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, file.body)
    await chmod(path, file.mode)
  }

  const archivePath = join(await scratch(), 'bundle.tar.gz')
  const packed = await runCommand({
    command: 'tar',
    args: ['-c', '-z', '-f', archivePath, '-C', source, '.'],
  })

  expect(packed.exitCode).toBe(0)

  return new Uint8Array(await readFile(archivePath))
}

const bundleRef = (digest: string): SetupBundleReference => ({
  bundleId: 'bundle-1',
  name: 'acme-client',
  version: '3',
  bucket: 'bundles',
  s3Key: 'acme/3/bundle.tar.gz',
  contentDigest: digest,
})

const bootstrapOptions = async (
  bundle: SetupBundleReference,
  archive: Uint8Array | undefined,
  reporter: BootstrapPhaseReporter,
) => {
  const store = createFakeArchiveStore()

  if (archive !== undefined) {
    store.put({ bucket: bundle.bucket, key: bundle.s3Key }, archive)
  }

  return {
    bundle,
    store,
    reporter,
    bundleDir: join(await scratch(), 'bundle'),
    workspaceRoot: '/workspace',
    agentConfigDir: '/workspace/.agent-config',
    workflowId: 'workflow-1',
  }
}

const SUCCESSFUL_SETUP = '#!/bin/sh\necho "installing for $SISYPHUS_WORKFLOW_ID"\nexit 0\n'

describe('phases 2–5 — the happy path', () => {
  it('downloads, verifies, unpacks and runs setup.sh, reporting each phase', async () => {
    const archive = await buildArchive({ 'setup.sh': { body: SUCCESSFUL_SETUP, mode: 0o755 } })
    const reporter = recordingReporter()
    const options = await bootstrapOptions(bundleRef(sha256Hex(archive)), archive, reporter)

    const result = await runBundleBootstrap(options)

    expect(reporter.finished.map((event) => event.phase)).toEqual([
      'bundle_download',
      'bundle_verify',
      'bundle_unpack',
      'setup_script',
    ])
    expect(reporter.finished.every((event) => event.outcome === 'succeeded')).toBe(true)
    expect(result.contentDigest).toBe(sha256Hex(archive))
    expect(result.archiveBytes).toBe(archive.byteLength)
    expect(result.setupOutput).toContain('installing for workflow-1')
  }, 30_000)

  it('gives every phase its own measured duration (FR-145)', async () => {
    const archive = await buildArchive({ 'setup.sh': { body: SUCCESSFUL_SETUP, mode: 0o755 } })
    const reporter = recordingReporter()

    await runBundleBootstrap(
      await bootstrapOptions(bundleRef(sha256Hex(archive)), archive, reporter),
    )

    for (const event of reporter.finished) {
      expect(event.durationMs).toBeGreaterThanOrEqual(0)
    }
  }, 30_000)

  it('surfaces the idempotency expectation where a bundle author will see it', async () => {
    const archive = await buildArchive({ 'setup.sh': { body: SUCCESSFUL_SETUP, mode: 0o755 } })
    const result = await runBundleBootstrap(
      await bootstrapOptions(bundleRef(sha256Hex(archive)), archive, nullPhaseReporter),
    )

    expect(result.notes).toContain(SETUP_SCRIPT_IDEMPOTENCY_NOTE)
    expect(SETUP_SCRIPT_IDEMPOTENCY_NOTE).toContain('idempotent')
    expect(SETUP_SCRIPT_IDEMPOTENCY_NOTE).toContain('restores a snapshot')
    // 003/FR-048. The note still asks for the repository-host and third-party
    // credentials to be reinstalled on every boot — those really are excluded
    // from snapshots and the bundle really is how they come back — and it now
    // tells an author not to install the agent's own login, which the platform
    // installs from its pool in a later phase.
    expect(SETUP_SCRIPT_IDEMPOTENCY_NOTE).toContain('repository-host')
    expect(SETUP_SCRIPT_IDEMPOTENCY_NOTE).toContain('FR-048')
  }, 30_000)

  it('redacts a credential setup.sh echoed, before it leaves the phase (FR-089)', async () => {
    const secret = 'AKIAIOSFODNN7EXAMPLEKEY'
    const archive = await buildArchive({
      'setup.sh': { body: `#!/bin/sh\necho "token ${secret}"\n`, mode: 0o755 },
    })
    const options = await bootstrapOptions(
      bundleRef(sha256Hex(archive)),
      archive,
      nullPhaseReporter,
    )

    const result = await runBundleBootstrap({
      ...options,
      secrets: [{ name: 'client-key', value: secret }],
    })

    expect(result.setupOutput).not.toContain(secret)
    expect(result.setupOutput).toContain('[redacted:client-key]')
  }, 30_000)

  it('is idempotent enough to run twice, as a restore boot does', async () => {
    const archive = await buildArchive({
      'setup.sh': {
        body: '#!/bin/sh\nmkdir -p credentials\ntouch credentials/token\n',
        mode: 0o755,
      },
    })
    const options = await bootstrapOptions(
      bundleRef(sha256Hex(archive)),
      archive,
      nullPhaseReporter,
    )

    await runBundleBootstrap(options)
    await expect(runBundleBootstrap(options)).resolves.toBeDefined()
  }, 30_000)
})

/**
 * **003/T062, FR-048, FR-052 — superseding `002/FR-043` and `002/FR-075`.**
 *
 * A bundle validation run exercises phases 2–5 and stops. It never reaches
 * `credential_install` and never reaches `agent_start`, which is exactly why
 * proving a bundle can consume no pool capacity — and the property that makes
 * that true is a negative one: nothing in these four phases asks for, receives,
 * or fails without an agent credential.
 *
 * The bundle may still legitimately install *other* credentials — the
 * repository-host credential `run/forge-credential.ts` reads back out of git,
 * and whatever third-party material `contracts/setup-bundle.md` lets it put
 * under `.agent-config/credentials/`. FR-048 is about the agent's own login and
 * nothing else, so the first test below installs a non-agent credential and
 * asserts it is untouched.
 */
describe('phases 2–5 without any agent credential (003/FR-048, FR-052)', () => {
  it('completes, and leaves the bundle’s own non-agent credentials alone', async () => {
    const configDir = join(await scratch(), '.agent-config')
    const archive = await buildArchive({
      'setup.sh': {
        // What a bundle still does: install the CLI's configuration and the
        // repository-host credential. It installs no agent login.
        body:
          '#!/bin/sh\n' +
          'mkdir -p "$SISYPHUS_AGENT_CONFIG_DIR/credentials"\n' +
          'printf %s "not-a-real-forge-credential-0001" > ' +
          '"$SISYPHUS_AGENT_CONFIG_DIR/credentials/forge"\n' +
          'exit 0\n',
        mode: 0o755,
      },
    })
    const reporter = recordingReporter()
    const options = await bootstrapOptions(bundleRef(sha256Hex(archive)), archive, reporter)

    const result = await runBundleBootstrap({ ...options, agentConfigDir: configDir })

    expect(reporter.finished.map((event) => event.phase)).toEqual([
      'bundle_download',
      'bundle_verify',
      'bundle_unpack',
      'setup_script',
    ])
    expect(reporter.finished.every((event) => event.outcome === 'succeeded')).toBe(true)
    expect(result.setupOutput).toBe('')
    // The non-agent credential the bundle installed is exactly where it put it.
    await expect(readFile(join(configDir, 'credentials', 'forge'), 'utf8')).resolves.toBe(
      'not-a-real-forge-credential-0001',
    )
  }, 30_000)

  it('never reports credential_install, because validation does not reach it (FR-052)', async () => {
    const archive = await buildArchive({ 'setup.sh': { body: SUCCESSFUL_SETUP, mode: 0o755 } })
    const reporter = recordingReporter()

    await runBundleBootstrap(
      await bootstrapOptions(bundleRef(sha256Hex(archive)), archive, reporter),
    )

    const phases = reporter.finished.map((event) => event.phase)

    expect(phases).not.toContain('credential_install')
    expect(phases).not.toContain('agent_start')
  }, 30_000)

  it('takes no option by which an agent credential could be supplied', async () => {
    const archive = await buildArchive({ 'setup.sh': { body: SUCCESSFUL_SETUP, mode: 0o755 } })
    const options = await bootstrapOptions(
      bundleRef(sha256Hex(archive)),
      archive,
      nullPhaseReporter,
    )

    // `secrets` carries values for *redaction* and nothing installs from it;
    // there is no `agentCredential`, no `material` and no fetch port anywhere on
    // this surface. That absence is what makes "a validation run consumes no
    // pool capacity" structural rather than a promise.
    expect(Object.keys(options).sort()).toStrictEqual([
      'agentConfigDir',
      'bundle',
      'bundleDir',
      'reporter',
      'store',
      'workflowId',
      'workspaceRoot',
    ])
  }, 30_000)
})

describe('phase 2 — bundle_download', () => {
  it('names its own phase when the archive is missing (FR-088)', async () => {
    const bundle = bundleRef('0'.repeat(64))
    const reporter = recordingReporter()
    const failure = await runBundleBootstrap(
      await bootstrapOptions(bundle, undefined, reporter),
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BootstrapPhaseError)
    expect(failure).toMatchObject({ phase: 'bundle_download' })
    expect((failure as BootstrapPhaseError).message).toContain('bundle_download')
    // Names the bundle too, not just the phase.
    expect((failure as BootstrapPhaseError).message).toContain('acme-client version 3')
    expect(reporter.finished).toEqual([
      expect.objectContaining({ phase: 'bundle_download', outcome: 'failed' }),
    ])
  }, 30_000)
})

describe('phase 3 — bundle_verify', () => {
  it('accepts bytes whose digest matches, case-insensitively on the registered value', () => {
    const bytes = new TextEncoder().encode('archive')
    const digest = sha256Hex(bytes)

    expect(verifyArchiveDigest(bundleRef(digest.toUpperCase()), bytes)).toBe(digest)
  })

  it('fails with both digests in the message, and is not retryable', () => {
    const bytes = new TextEncoder().encode('the bytes that arrived')
    const registered = sha256Hex(new TextEncoder().encode('the bytes that were registered'))
    const failure = (() => {
      try {
        verifyArchiveDigest(bundleRef(registered), bytes)
      } catch (error) {
        return error as BootstrapPhaseError
      }

      throw new Error('expected a digest mismatch')
    })()

    expect(failure.phase).toBe('bundle_verify')
    expect(failure.retryable).toBe(false)
    expect(failure.message).toContain('bootstrap phase bundle_verify failed')
    expect(failure.message).toContain(`sha256:${sha256Hex(bytes)}`)
    expect(failure.message).toContain(`sha256:${registered}`)
    expect(failure.message).toContain('not recoverable by retry')
  })

  it('stops the run before unpack, so the agent is never started', async () => {
    const archive = await buildArchive({ 'setup.sh': { body: SUCCESSFUL_SETUP, mode: 0o755 } })
    const reporter = recordingReporter()
    const failure = await runBundleBootstrap(
      await bootstrapOptions(bundleRef('f'.repeat(64)), archive, reporter),
    ).catch((error: unknown) => error)

    expect(failure).toMatchObject({ phase: 'bundle_verify', retryable: false })
    expect(reporter.finished.map((event) => event.phase)).toEqual([
      'bundle_download',
      'bundle_verify',
    ])
    expect(reporter.finished[1]?.detail).toContain('not recoverable by retry')
  }, 30_000)
})

describe('phase 4 — bundle_unpack', () => {
  it('fails when there is no setup.sh at the archive root', async () => {
    const archive = await buildArchive({
      'nested/setup.sh': { body: SUCCESSFUL_SETUP, mode: 0o755 },
    })
    const failure = await runBundleBootstrap(
      await bootstrapOptions(bundleRef(sha256Hex(archive)), archive, nullPhaseReporter),
    ).catch((error: unknown) => error)

    expect(failure).toMatchObject({ phase: 'bundle_unpack' })
    expect((failure as BootstrapPhaseError).message).toContain('no setup.sh at the archive root')
  }, 30_000)

  it('fails when setup.sh is present but not executable', async () => {
    const archive = await buildArchive({ 'setup.sh': { body: SUCCESSFUL_SETUP, mode: 0o644 } })
    const failure = await runBundleBootstrap(
      await bootstrapOptions(bundleRef(sha256Hex(archive)), archive, nullPhaseReporter),
    ).catch((error: unknown) => error)

    expect(failure).toMatchObject({ phase: 'bundle_unpack' })
    expect((failure as BootstrapPhaseError).message).toContain('not executable')
    expect((failure as BootstrapPhaseError).message).toContain('644')
  }, 30_000)

  it('accepts any execute bit rather than insisting on 0755', async () => {
    const directory = await scratch()

    await writeFile(join(directory, 'setup.sh'), SUCCESSFUL_SETUP)
    await chmod(join(directory, 'setup.sh'), 0o700)

    await expect(assertSetupScript(bundleRef('x'), directory)).resolves.toBe(
      join(directory, 'setup.sh'),
    )
  })

  it('fails when setup.sh at the root is a directory', async () => {
    const directory = await scratch()

    await mkdir(join(directory, 'setup.sh'))

    await expect(assertSetupScript(bundleRef('x'), directory)).rejects.toMatchObject({
      phase: 'bundle_unpack',
    })
  })

  it('fails when the archive is not a gzipped tar at all', async () => {
    const archive = new TextEncoder().encode('this is a zip file, honestly')
    const failure = await runBundleBootstrap(
      await bootstrapOptions(bundleRef(sha256Hex(archive)), archive, nullPhaseReporter),
    ).catch((error: unknown) => error)

    expect(failure).toMatchObject({ phase: 'bundle_unpack' })
  }, 30_000)
})

describe('phase 5 — setup_script', () => {
  it('fails naming the phase and the exit code (FR-088)', async () => {
    const archive = await buildArchive({
      'setup.sh': { body: '#!/bin/sh\necho "no credential here"\nexit 7\n', mode: 0o755 },
    })
    const reporter = recordingReporter()
    const failure = await runBundleBootstrap(
      await bootstrapOptions(bundleRef(sha256Hex(archive)), archive, reporter),
    ).catch((error: unknown) => error)

    expect(failure).toMatchObject({ phase: 'setup_script' })
    expect((failure as BootstrapPhaseError).message).toContain('exited with code 7')
    expect(reporter.finished.at(-1)).toMatchObject({ phase: 'setup_script', outcome: 'failed' })
  }, 30_000)

  it('times out on its own clock, reporting timed_out against setup_script (FR-146)', async () => {
    const archive = await buildArchive({
      'setup.sh': { body: '#!/bin/sh\nsleep 30\n', mode: 0o755 },
    })
    const reporter = recordingReporter()
    const options = await bootstrapOptions(bundleRef(sha256Hex(archive)), archive, reporter)
    const failure = await runBundleBootstrap({
      ...options,
      timeouts: { setup_script: 200 },
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ phase: 'setup_script', timedOut: true })
    expect((failure as BootstrapPhaseError).message).toContain('exceeded its own timeout')
    expect(reporter.finished.at(-1)?.outcome).toBe('timed_out')
  }, 30_000)

  it('gives setup.sh the three environment variables the contract promises', async () => {
    const archive = await buildArchive({
      'setup.sh': {
        body:
          '#!/bin/sh\n' +
          'echo "root=$SISYPHUS_WORKSPACE_ROOT"\n' +
          'echo "config=$SISYPHUS_AGENT_CONFIG_DIR"\n' +
          'echo "workflow=$SISYPHUS_WORKFLOW_ID"\n',
        mode: 0o755,
      },
    })
    const result = await runBundleBootstrap(
      await bootstrapOptions(bundleRef(sha256Hex(archive)), archive, nullPhaseReporter),
    )

    expect(result.setupOutput).toContain('root=/workspace')
    expect(result.setupOutput).toContain('config=/workspace/.agent-config')
    expect(result.setupOutput).toContain('workflow=workflow-1')
  }, 30_000)
})
