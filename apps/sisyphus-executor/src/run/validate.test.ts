import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createFakeArchiveStore, runCommand, sha256Hex } from '../bootstrap'
import type { ValidationJobEnvelope } from '../job-envelope'
import type {
  ValidationReportResult,
  ValidationRunReport,
  ValidationSurfaceClient,
} from '../report'
import type { ObjectLocation, S3Operations } from '../storage'

import type { ValidationEnvironment } from './validate'
import { runValidation, validationOutputKey, validationPhaseReport } from './validate'

/**
 * A bundle validation, end to end on the instance side (T200, FR-147, FR-148).
 *
 * Nothing here opens a socket and nothing reaches the machine surface: the archive store, the object
 * store and the reporting client are all seams. What is real is the part that has to be —
 * `runBundleBootstrap` downloads, hashes, unpacks and executes a genuine `setup.sh`, because the
 * whole claim a validation makes is that it exercises the same code a real boot does.
 */

const scratchDirectories: string[] = []

const scratch = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'sisyphus-validate-'))

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

/** A real gzipped tar built with real `tar`, since that is what production unpacks. */
const buildArchive = async (
  files: Readonly<Record<string, { body: string; mode: number }>>,
): Promise<Uint8Array> => {
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

const S3_KEY = 'acme/3/bundle.tar.gz'

const envelopeFor = (contentDigest: string): ValidationJobEnvelope => ({
  mode: 'validation',
  machineSurfaceUrl: 'https://panel.example.test/api/machine',
  scopedCredential: 'a-validation-token',
  setupBundle: { s3Key: S3_KEY, contentDigest, version: 3 },
})

const environmentIn = async (): Promise<ValidationEnvironment> => ({
  region: 'eu-west-2',
  machineSurfaceUrl: 'https://fallback.example.test/api/machine',
  bundlesBucket: 'bundles',
  logsBucket: 'logs',
  workspaceRoot: await scratch(),
})

/** An in-memory object store, so nothing is written to a bucket. */
const fakeOperations = (): S3Operations & { readonly puts: Map<string, string> } => {
  const puts = new Map<string, string>()

  return {
    puts,
    getBytes: () => Promise.resolve(undefined),
    putBytes: (location: ObjectLocation, bytes: Uint8Array) => {
      puts.set(`${location.bucket}/${location.key}`, new TextDecoder().decode(bytes))
      return Promise.resolve()
    },
    putFile: () => Promise.resolve(),
    getFile: () => Promise.resolve(false),
  }
}

const recordedReport = (): ValidationReportResult => ({
  validationRunId: '01890a5d-ac96-774b-bcce-b302099a9001',
  outcome: 'passed',
  run: null,
  alreadyRecorded: false,
})

const capturingClient = (): ValidationSurfaceClient & {
  readonly sent: ValidationRunReport[]
} => {
  const sent: ValidationRunReport[] = []

  return {
    sent,
    reportValidation: (report) => {
      sent.push(report)
      return Promise.resolve(recordedReport())
    },
  }
}

const SUCCESSFUL_SETUP = '#!/bin/sh\necho "installing for $SISYPHUS_WORKFLOW_ID"\nexit 0\n'
const FAILING_SETUP = '#!/bin/sh\necho "npm ci exploded" >&2\nexit 7\n'

const runWith = async (options: {
  readonly archive?: Uint8Array
  readonly contentDigest?: string
}) => {
  const environment = await environmentIn()
  const archive = options.archive
  const digest = options.contentDigest ?? (archive === undefined ? 'absent' : sha256Hex(archive))
  const envelope = envelopeFor(digest)

  const archives = createFakeArchiveStore()
  if (archive !== undefined) {
    archives.put({ bucket: environment.bundlesBucket, key: S3_KEY }, archive)
  }

  const operations = fakeOperations()
  const client = capturingClient()

  const outcome = await runValidation({
    envelope,
    environment,
    client,
    archives,
    operations,
    bundleDir: join(await scratch(), 'bundle'),
    token: 'fixed-token',
  })

  return { outcome, client, operations, environment, digest }
}

describe('proving a bundle that works', () => {
  it('runs phases 2–5 and reports every one of them (FR-147)', async () => {
    const archive = await buildArchive({ 'setup.sh': { body: SUCCESSFUL_SETUP, mode: 0o755 } })
    const { client } = await runWith({ archive })

    expect(client.sent).toHaveLength(1)
    expect(client.sent[0]?.phaseResults.map((result) => result.phase)).toStrictEqual([
      'bundle_download',
      'bundle_verify',
      'bundle_unpack',
      'setup_script',
    ])
    expect(client.sent[0]?.phaseResults.every((result) => result.outcome === 'succeeded')).toBe(
      true,
    )
  })

  it('stores the captured setup output and reports where it went (FR-148)', async () => {
    const archive = await buildArchive({ 'setup.sh': { body: SUCCESSFUL_SETUP, mode: 0o755 } })
    const { outcome, operations, digest } = await runWith({ archive })

    const key = validationOutputKey(digest, 'fixed-token')
    expect(outcome.outputS3Key).toBe(key)
    expect(operations.puts.get(`logs/${key}`)).toContain('installing for validation:')
  })

  it('reports no workflow id anywhere, because there is no workflow (003/FR-052)', async () => {
    const archive = await buildArchive({ 'setup.sh': { body: SUCCESSFUL_SETUP, mode: 0o755 } })
    const { client } = await runWith({ archive })

    expect(JSON.stringify(client.sent[0])).not.toContain('workflowId')
  })
})

describe('proving a bundle that does not work', () => {
  it('reports a failing setup.sh as a result rather than raising (FR-147)', async () => {
    // The case a validation exists to discover. A throw here would leave the instance holding the
    // only evidence of the failure, which is the opposite of the point.
    const archive = await buildArchive({ 'setup.sh': { body: FAILING_SETUP, mode: 0o755 } })
    const { outcome, client } = await runWith({ archive })

    const setup = client.sent[0]?.phaseResults.at(-1)
    expect(setup?.phase).toBe('setup_script')
    expect(setup?.outcome).toBe('failed')
    expect(setup?.detail).toContain('7')
    expect(outcome.report).toStrictEqual(recordedReport())
  })

  it('reports the phase that failed and nothing after it', async () => {
    // A digest mismatch stops at `bundle_verify`. The phases that never ran are absent rather than
    // reported as failures — the surface treats an unreported phase as one that did not happen.
    const archive = await buildArchive({ 'setup.sh': { body: SUCCESSFUL_SETUP, mode: 0o755 } })
    const { client } = await runWith({ archive, contentDigest: 'a'.repeat(64) })

    expect(client.sent[0]?.phaseResults.map((result) => result.phase)).toStrictEqual([
      'bundle_download',
      'bundle_verify',
    ])
    expect(client.sent[0]?.phaseResults.at(-1)?.outcome).toBe('failed')
  })

  it('reports a missing archive as a failed download, with no output key', async () => {
    const { outcome, client } = await runWith({})

    expect(client.sent[0]?.phaseResults).toHaveLength(1)
    expect(client.sent[0]?.phaseResults.at(0)).toMatchObject({
      phase: 'bundle_download',
      outcome: 'failed',
    })
    // Nothing ran, so there is nothing to store; an empty object behind a link is worse than none.
    expect(outcome.outputS3Key).toBeUndefined()
    expect(client.sent[0]?.outputS3Key).toBeUndefined()
  })
})

describe('when storage is the thing that is broken', () => {
  it('still reports the phases, and says the output could not be stored', async () => {
    // A validation whose output could not be stored still has per-phase results, which are the
    // larger part of FR-148's answer. Losing the verdict over a bucket would be the wrong trade.
    const archive = await buildArchive({ 'setup.sh': { body: FAILING_SETUP, mode: 0o755 } })
    const environment = await environmentIn()
    const archives = createFakeArchiveStore()
    archives.put({ bucket: environment.bundlesBucket, key: S3_KEY }, archive)

    const onOutputFailure = vi.fn()
    const client = capturingClient()

    const outcome = await runValidation({
      envelope: envelopeFor(sha256Hex(archive)),
      environment,
      client,
      archives,
      operations: {
        ...fakeOperations(),
        putBytes: () => Promise.reject(new Error('the logs bucket is unreachable')),
      },
      bundleDir: join(await scratch(), 'bundle'),
      onOutputFailure,
    })

    expect(onOutputFailure).toHaveBeenCalledOnce()
    expect(outcome.outputS3Key).toBeUndefined()
    expect(client.sent[0]?.phaseResults.at(-1)?.outcome).toBe('failed')
  })
})

describe('the object key', () => {
  it('groups every proof of one archive, without overwriting an earlier one', () => {
    expect(validationOutputKey('abc123', 'run-1')).toBe('validations/abc123/run-1.txt')
    expect(validationOutputKey('abc123', 'run-2')).not.toBe(validationOutputKey('abc123', 'run-1'))
  })
})

describe('translating a bootstrap phase into a report', () => {
  it('drops a phase a validation cannot reach, rather than sending a report the surface rejects', () => {
    // The far-side schema refuses `agent_start`, and a report refused wholesale for one stray phase
    // would lose four good ones.
    expect(
      validationPhaseReport({ phase: 'agent_start', outcome: 'succeeded', durationMs: 1 }),
    ).toBeUndefined()
    expect(
      validationPhaseReport({ phase: 'credential_install', outcome: 'succeeded', durationMs: 1 }),
    ).toBeUndefined()
  })

  it('keeps the duration and sanitises the detail (FR-045, FR-089)', () => {
    const report = validationPhaseReport({
      phase: 'setup_script',
      outcome: 'failed',
      detail: 'exit 7[0m',
      durationMs: 42,
    })

    expect(report).toMatchObject({ phase: 'setup_script', outcome: 'failed', durationMs: 42 })
    // The control sequence is stripped by the sanitiser, which is the only construction site for
    // the branded type the report requires.
    expect(report?.detail).toBe('exit 7')
  })
})
