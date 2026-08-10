import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as MainModule from './main'

/**
 * **The executor's entry point (T173, FR-203).**
 *
 * `main.ts` ends in a top-level `main().catch(...)`, so importing the file *is* running the
 * process. That is what makes it reachable from here rather than only from a provisioned instance:
 * `node:process` is replaced with an in-memory stand-in, the four collaborators the entry point
 * composes are mocked at their barrels, and each test resets the module registry and imports the
 * file again — one import, one run.
 *
 * Only what this file decides is asserted: where the envelope is read from, that a validation
 * envelope is refused before anything is assembled, which exit code each ending produces, and that
 * both signals are armed once and converge on the one registry. The assembly belongs to
 * `run/assemble.test.ts`, the envelope grammar to `job-envelope.test.ts`, and the once-only
 * guarantee to `runtime/shutdown.test.ts`.
 */

const ENVELOPE_TEXT = '{"mode":"workflow"}'

/** The smallest thing `for await` accepts — no stream, no generator, no timing. */
const chunkStream = (
  chunks: readonly (Uint8Array | string)[],
): AsyncIterable<Uint8Array | string> => ({
  [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array | string> => {
    let index = 0

    return {
      next: (): Promise<IteratorResult<Uint8Array | string>> => {
        if (index >= chunks.length) {
          return Promise.resolve({ done: true, value: undefined })
        }

        const value = chunks[index]
        index += 1

        return Promise.resolve({ done: false, value })
      },
    }
  },
})

interface SignalRegistration {
  readonly signal: string
  readonly handler: () => void
}

const stdout: string[] = []
const stderr: string[] = []
const registrations: SignalRegistration[] = []

/**
 * The process, as far as `main.ts` can tell.
 *
 * `once` is the only listener method it has. A `main.ts` that reached for `process.on` would fail
 * here with a TypeError rather than quietly registering a handler that can fire twice — which is
 * the whole point of the single-shutdown contract.
 */
const fakeProcess = {
  argv: ['node', '/opt/sisyphus/executor.mjs'],
  stdin: chunkStream([]),
  exitCode: undefined as number | undefined,
  once: (signal: string, handler: () => void): void => {
    registrations.push({ signal, handler })
  },
  stdout: {
    write: (text: string): void => {
      stdout.push(text)
    },
  },
  stderr: {
    write: (text: string): void => {
      stderr.push(text)
    },
  },
}

const env = {
  AWS_REGION: 'eu-west-2',
  SISYPHUS_MACHINE_SURFACE_URL: 'https://sisyphus.test/api/machine',
  SISYPHUS_FORGE_API_URL: 'https://api.forge.test',
  SISYPHUS_BUNDLES_BUCKET: 'sisyphus-staging-bundles',
  SISYPHUS_LOGS_BUCKET: 'sisyphus-staging-logs',
  SISYPHUS_SNAPSHOTS_BUCKET: 'sisyphus-staging-snapshots',
  SISYPHUS_WORKSPACE_ROOT: '/workspace',
}

const ENVELOPE = { mode: 'workflow', marker: 'the-parsed-envelope' }

const parseJobEnvelope = vi.fn<(text: string) => Record<string, unknown>>(() => ENVELOPE)

interface AssembleCall {
  readonly envelope: unknown
  readonly environment: Record<string, string>
  readonly shutdown: unknown
  readonly onReportingFailure: (error: unknown, detail: string) => void
}

interface RunResult {
  readonly outcome: string
  readonly reason: string
}

const assembledOptions = { marker: 'the-run-options' }

const assembleRun = vi.fn<(options: AssembleCall) => { options: typeof assembledOptions }>(() => ({
  options: assembledOptions,
}))

const runExecutor = vi.fn<(options: unknown) => Promise<RunResult>>(() =>
  Promise.resolve({ outcome: 'succeeded', reason: 'the delegated workflow finished' }),
)

const validationSeams = { marker: 'the-validation-seams' }

const assembleValidation = vi.fn(() => validationSeams)

const runValidation = vi.fn<(options: unknown) => Promise<{ report: { outcome: string } }>>(() =>
  Promise.resolve({ report: { outcome: 'passed' } }),
)

/** Errors the next signalled shutdown will report. Emptied between tests. */
const shutdownErrors: Error[] = []

const registry = {
  onShutdown: vi.fn<(hook: () => void) => () => void>(() => () => undefined),
  shutdown: vi.fn((reason: { source: string }) =>
    Promise.resolve({ reason, errors: [...shutdownErrors] }),
  ),
  isShuttingDown: false,
}

const createShutdownRegistry = vi.fn(() => registry)

vi.mock('node:process', () => ({ default: fakeProcess }))
vi.mock('./env', () => ({ env }))
vi.mock('./job-envelope', () => ({ parseJobEnvelope }))
vi.mock('./run', () => ({ assembleRun, assembleValidation, runExecutor, runValidation }))
vi.mock('./runtime', () => ({ createShutdownRegistry }))

/**
 * Import the entry point, which runs it.
 *
 * Resolves once that run has settled — which it signals by setting an exit code on both the
 * success path and the catch, so waiting on one is waiting on either ending.
 */
const importMain = async (): Promise<typeof MainModule> => {
  vi.resetModules()

  const module = await import('./main')

  await vi.waitFor(() => {
    expect(fakeProcess.exitCode).toBeTypeOf('number')
  })

  return module
}

const scratchDirectories: string[] = []

const scratch = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'sisyphus-main-'))

  scratchDirectories.push(directory)

  return directory
}

beforeEach(() => {
  stdout.length = 0
  stderr.length = 0
  registrations.length = 0
  shutdownErrors.length = 0

  fakeProcess.argv = ['node', '/opt/sisyphus/executor.mjs']
  fakeProcess.stdin = chunkStream([ENVELOPE_TEXT])
  fakeProcess.exitCode = undefined

  for (const mock of [
    parseJobEnvelope,
    assembleRun,
    assembleValidation,
    runExecutor,
    runValidation,
    createShutdownRegistry,
    registry.onShutdown,
    registry.shutdown,
  ]) {
    mock.mockClear()
  }
})

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('readEnvelopeText', () => {
  it('reads the file the first argument names, in preference to stdin', async () => {
    const { readEnvelopeText } = await importMain()
    const file = join(await scratch(), 'envelope.json')

    await writeFile(file, ENVELOPE_TEXT, 'utf8')

    await expect(readEnvelopeText([file], chunkStream(['from stdin']))).resolves.toBe(ENVELOPE_TEXT)
  })

  it('reads stdin when the argument is the conventional "-"', async () => {
    const { readEnvelopeText } = await importMain()

    await expect(readEnvelopeText(['-'], chunkStream(['from stdin']))).resolves.toBe('from stdin')
  })

  it('reads stdin when there is no argument at all', async () => {
    const { readEnvelopeText } = await importMain()

    await expect(readEnvelopeText([], chunkStream(['from stdin']))).resolves.toBe('from stdin')
  })

  it('joins the chunks in order, decoding the byte ones as UTF-8', async () => {
    const { readEnvelopeText } = await importMain()
    const encoder = new TextEncoder()

    // A launch unit pipes bytes; an interactive run or a test may write strings. The pound sign is
    // two bytes, so a decoder that assumed one byte per character would show it here.
    const stream = chunkStream([encoder.encode('{"spendCap":"£'), '12', encoder.encode('.50"}')])

    await expect(readEnvelopeText([], stream)).resolves.toBe('{"spendCap":"£12.50"}')
  })

  it('answers the empty string for a stdin that closed without a byte', async () => {
    const { readEnvelopeText } = await importMain()

    await expect(readEnvelopeText([], chunkStream([]))).resolves.toBe('')
  })

  it('rejects rather than inventing an envelope when the named file is not there', async () => {
    const { readEnvelopeText } = await importMain()
    const missing = join(await scratch(), 'never-written.json')

    await expect(readEnvelopeText([missing], chunkStream([]))).rejects.toThrow('ENOENT')
  })
})

describe('the entry point', () => {
  it('reads the envelope off the process stdin when argv carries no path', async () => {
    await importMain()

    expect(parseJobEnvelope).toHaveBeenCalledExactlyOnceWith(ENVELOPE_TEXT)
  })

  it('reads the envelope off the path argv carries, past node and the script', async () => {
    const file = join(await scratch(), 'user-data.json')

    await writeFile(file, '{"mode":"workflow","from":"the launch unit"}', 'utf8')
    fakeProcess.argv = ['node', '/opt/sisyphus/executor.mjs', file]

    await importMain()

    expect(parseJobEnvelope).toHaveBeenCalledExactlyOnceWith(
      '{"mode":"workflow","from":"the launch unit"}',
    )
  })

  it('assembles the run from the validated environment and the one registry', async () => {
    await importMain()

    expect(assembleRun).toHaveBeenCalledOnce()
    expect(createShutdownRegistry).toHaveBeenCalledOnce()
    expect(assembleRun.mock.calls.at(0)?.[0]).toMatchObject({
      envelope: ENVELOPE,
      environment: {
        region: 'eu-west-2',
        machineSurfaceUrl: 'https://sisyphus.test/api/machine',
        forgeApiUrl: 'https://api.forge.test',
        bundlesBucket: 'sisyphus-staging-bundles',
        logsBucket: 'sisyphus-staging-logs',
        snapshotsBucket: 'sisyphus-staging-snapshots',
        workspaceRoot: '/workspace',
      },
      shutdown: registry,
    })
  })

  it('passes the forge API base through, or nothing can address the code host', async () => {
    await importMain()

    // `toMatchObject` above would pass with the field absent from the schema entirely, which is
    // exactly the regression this asserts against: a run whose forge has no base URL fails at the
    // first request with an invalid URL rather than at boot with a named variable.
    expect(assembleRun.mock.calls.at(0)?.[0].environment).toHaveProperty(
      'forgeApiUrl',
      'https://api.forge.test',
    )
  })

  it('runs exactly what it assembled, and nothing it built itself', async () => {
    await importMain()

    expect(runExecutor).toHaveBeenCalledExactlyOnceWith(assembledOptions)
  })

  it('writes the outcome to the instance console, which is all an operator may have', async () => {
    await importMain()

    expect(stdout.join('')).toBe('[executor] succeeded: the delegated workflow finished\n')
  })

  it.each(['succeeded', 'failed', 'capped', 'cancelled', 'needs_attention', 'parked_resumable'])(
    'exits 0 after reporting a %s run, so the supervisor restarts nothing',
    async (outcome) => {
      runExecutor.mockResolvedValueOnce({ outcome, reason: 'reported' })

      await importMain()

      expect(fakeProcess.exitCode).toBe(0)
    },
  )

  it('exits 1 and names the fault when the envelope is unusable', async () => {
    parseJobEnvelope.mockImplementationOnce(() => {
      throw new Error('the envelope is not valid JSON')
    })

    await importMain()

    expect(fakeProcess.exitCode).toBe(1)
    expect(stderr.join('')).toBe(
      '[executor] the run could not be started or could not report: the envelope is not valid JSON\n',
    )
    expect(assembleRun).not.toHaveBeenCalled()
    expect(runExecutor).not.toHaveBeenCalled()
  })

  it('exits 1 when the assembly threw before the reporting path was armed', async () => {
    assembleRun.mockImplementationOnce(() => {
      throw new Error('the bundles bucket is not reachable')
    })

    await importMain()

    expect(fakeProcess.exitCode).toBe(1)
    expect(stderr.join('')).toContain('the bundles bucket is not reachable')
    expect(runExecutor).not.toHaveBeenCalled()
  })

  it('exits 1 when the run itself rejected rather than returning an outcome', async () => {
    runExecutor.mockRejectedValueOnce(new Error('the machine surface refused every report'))

    await importMain()

    expect(fakeProcess.exitCode).toBe(1)
    expect(stdout).toStrictEqual([])
  })

  it('still names a throw that was not an Error', async () => {
    parseJobEnvelope.mockImplementationOnce(() => {
      // A dependency that throws a bare value is exactly what the String() fallback is for.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'user-data was empty'
    })

    await importMain()

    expect(fakeProcess.exitCode).toBe(1)
    expect(stderr.join('')).toContain('user-data was empty')
  })

  it('runs a validation envelope as a validation, never as a workflow (T200, FR-147)', async () => {
    // This used to assert the opposite: that `main` refused the envelope and exited 1 having
    // attempted nothing, because the machine surface had no procedure a run without a workflow
    // could report to. `machine.reportValidation` is that procedure.
    parseJobEnvelope.mockReturnValueOnce({ mode: 'validation' })

    await importMain()

    expect(assembleValidation).toHaveBeenCalledOnce()
    expect(runValidation).toHaveBeenCalledOnce()
    // The two paths do not meet: a validation must never be assembled as a workflow, which has an
    // agent, a workspace and a terminal report it has no input for.
    expect(assembleRun).not.toHaveBeenCalled()
    expect(runExecutor).not.toHaveBeenCalled()
  })

  it('exits 0 for a validation that reported, whatever verdict it carried', async () => {
    // A bundle that fails at its first phase is a validation that *worked*. A non-zero exit would
    // tell the instance's supervisor to restart something that has already delivered its result.
    parseJobEnvelope.mockReturnValueOnce({ mode: 'validation' })
    runValidation.mockResolvedValueOnce({ report: { outcome: 'failed' } })

    await importMain()

    expect(fakeProcess.exitCode).toBe(0)
    expect(stdout.join('')).toContain('validation failed')
  })

  it('exits 1 when a validation could not report at all', async () => {
    // The one condition nobody upstream can see: the run happened and said nothing, so the
    // instance's own console is the only record.
    parseJobEnvelope.mockReturnValueOnce({ mode: 'validation' })
    runValidation.mockRejectedValueOnce(new Error('the validation result could not be reported'))

    await importMain()

    expect(fakeProcess.exitCode).toBe(1)
    expect(stderr.join('')).toContain('could not be reported')
  })

  it('arms both signals once each, through the single-shot listener', async () => {
    await importMain()

    expect(registrations.map((registration) => registration.signal)).toStrictEqual([
      'SIGTERM',
      'SIGINT',
    ])
  })

  it('arms them before the envelope is read, so a signal during assembly still lands', async () => {
    fakeProcess.argv = ['node', '/opt/sisyphus/executor.mjs', join(await scratch(), 'absent.json')]

    await importMain()

    expect(fakeProcess.exitCode).toBe(1)
    expect(parseJobEnvelope).not.toHaveBeenCalled()
    expect(registrations.map((registration) => registration.signal)).toStrictEqual([
      'SIGTERM',
      'SIGINT',
    ])
  })

  it('converges both signals on the one registry, naming which one arrived', async () => {
    await importMain()

    for (const registration of registrations) {
      registration.handler()
    }

    await vi.waitFor(() => {
      expect(registry.shutdown).toHaveBeenCalledTimes(2)
    })

    expect(createShutdownRegistry).toHaveBeenCalledOnce()
    expect(registry.shutdown.mock.calls.map(([reason]) => reason.source)).toStrictEqual([
      'SIGTERM',
      'SIGINT',
    ])
  })

  it('leaves the exit code at 0 when a signalled shutdown ran clean', async () => {
    await importMain()

    registrations.at(0)?.handler()

    await vi.waitFor(() => {
      expect(registry.shutdown).toHaveBeenCalledOnce()
    })

    expect(fakeProcess.exitCode).toBe(0)
  })

  it('raises the exit code to 1 when a signalled shutdown left errors behind', async () => {
    await importMain()

    expect(fakeProcess.exitCode).toBe(0)

    shutdownErrors.push(new Error('the snapshot did not upload'))
    registrations.at(0)?.handler()

    await vi.waitFor(() => {
      expect(fakeProcess.exitCode).toBe(1)
    })
  })

  it('reports a reporting failure to stderr without ending the run (FR-047)', async () => {
    await importMain()

    const assembled = assembleRun.mock.calls.at(0)?.[0]

    expect(assembled).toBeDefined()
    assembled?.onReportingFailure(new Error('502 from the surface'), 'the phase report')

    expect(stderr.join('')).toBe('[executor] the phase report: 502 from the surface\n')
    expect(fakeProcess.exitCode).toBe(0)
  })

  it('names a reporting failure that was not an Error', async () => {
    await importMain()

    assembleRun.mock.calls.at(0)?.[0].onReportingFailure('the socket closed', 'the segment upload')

    expect(stderr.join('')).toBe('[executor] the segment upload: the socket closed\n')
  })
})
