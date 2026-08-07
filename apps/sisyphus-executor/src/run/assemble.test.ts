import { describe, expect, it } from 'vitest'

import type { AgentFrame } from '../agent'
import type { WorkflowJobEnvelope } from '../job-envelope'
import { parseJobEnvelope } from '../job-envelope'
import { createShutdownRegistry } from '../runtime'
import type { ObjectLocation, S3Operations } from '../storage'

import { assembleRun, noWorkflowPorts, validationModeUnsupportedError } from './assemble'
import type { ExecutorEnvironment } from './assemble'
import { dispatchWorkflow } from './dispatch'
import type {
  CredentialFillCommand,
  CredentialFillResult,
  CredentialFiller,
} from './forge-credential'

/**
 * The assembly (T173, FR-203).
 *
 * Nothing here opens a socket: the S3 seam and the agent adapter are injected, and the machine
 * surface client is built but never called. What is asserted is the wiring — which bucket each
 * store points at, that the envelope's machine surface URL wins over the instance's fallback, and
 * that the ports gap is a named halt rather than a silent no-op.
 */

const ENVIRONMENT: ExecutorEnvironment = {
  region: 'eu-west-2',
  machineSurfaceUrl: 'https://fallback.test/api/machine',
  forgeApiUrl: 'https://api.forge.test',
  bundlesBucket: 'sisyphus-bundles',
  logsBucket: 'sisyphus-logs',
  snapshotsBucket: 'sisyphus-snapshots',
  workspaceRoot: '/workspace',
}

/** Records what the assembly asked git, and answers without spawning anything. */
const recordingFiller = (
  answer: Partial<CredentialFillResult> = {},
): CredentialFiller & { readonly calls: CredentialFillCommand[] } => {
  const calls: CredentialFillCommand[] = []
  const filler = async (command: CredentialFillCommand): Promise<CredentialFillResult> => {
    calls.push(command)

    return Promise.resolve({
      stdout: 'password=forge-credential-from-the-bundle\n',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      ...answer,
    })
  }

  return Object.assign(filler, { calls })
}

const recordingOperations = (): S3Operations & { readonly reads: ObjectLocation[] } => {
  const reads: ObjectLocation[] = []

  return {
    reads,
    getBytes: async (location) => {
      reads.push(location)

      return Promise.resolve(new TextEncoder().encode('archive'))
    },
    putBytes: async () => Promise.resolve(),
    putFile: async () => Promise.resolve(),
    getFile: async () => Promise.resolve(true),
  }
}

const envelope = (overrides: Record<string, unknown> = {}): WorkflowJobEnvelope =>
  parseJobEnvelope(
    JSON.stringify({
      mode: 'workflow',
      workflowId: '019fd631-15bf-7a03-a1c6-ff6d568c2654',
      sessionId: '019fd631-15bf-7a03-a1c6-ff6d568c2655',
      machineSurfaceUrl: 'https://sisyphus.test/api/machine',
      scopedCredential: 'scoped.credential.value',
      setupBundle: { s3Key: 'acme/3/bundle.tar.gz', contentDigest: 'a'.repeat(64), version: 3 },
      workspace: {
        root: '/workspace',
        entries: [
          {
            entryId: '019fd631-15bf-7a03-a1c6-ff6d568c2660',
            repositoryUrl: 'https://git.test/acme/app.git',
            baseBranch: 'integration-line',
            subdirectory: 'app',
            isPrimary: true,
          },
        ],
      },
      job: { model: 'claude-opus-5', turnCap: null, spendCap: null, workflowType: 'delegated' },
      prompt: { assembled: 'Add a changelog entry.' },
      ...overrides,
    }),
  ) as WorkflowJobEnvelope

const assemble = (overrides: Partial<Parameters<typeof assembleRun>[0]> = {}) =>
  assembleRun({
    envelope: envelope(),
    environment: ENVIRONMENT,
    shutdown: createShutdownRegistry(),
    operations: recordingOperations(),
    fillCredential: recordingFiller(),
    adapter: {
      start: async () => Promise.resolve(),
      sendTurn: async () => Promise.resolve({ acknowledged: true, latencyMs: 0 }),
      quiesce: async () =>
        Promise.resolve({ usage: { turns: 0, spendUsd: 0 }, waitedForTurn: false }),
      stop: async () => Promise.resolve({ exitCode: 0, signal: null, forced: false }),
      output: (async function* (): AsyncGenerator<AgentFrame> {
        // No frames: nothing in this suite consumes the stream.
        yield* await Promise.resolve([])
      })(),
      usage: { turns: 0, spendUsd: 0 },
    },
    ...overrides,
  })

describe('assembleRun', () => {
  it('points the bundle store at the instance’s bundles bucket, not the envelope’s', async () => {
    const operations = recordingOperations()
    const assembled = assemble({ operations })

    await assembled.options.archives.get({
      bucket: 'sisyphus-bundles',
      key: 'acme/3/bundle.tar.gz',
    })

    expect(operations.reads).toStrictEqual([
      { bucket: 'sisyphus-bundles', key: 'acme/3/bundle.tar.gz' },
    ])
    expect(assembled.options.bundlesBucket).toBe('sisyphus-bundles')
  })

  it('carries the pinned workspace root through unchanged (FR-051)', () => {
    expect(assemble().options.workspaceRoot).toBe('/workspace')
  })

  it('builds every store, the snapshot writer and the client for one run', () => {
    const assembled = assemble()

    expect(assembled.options.segments).toBeDefined()
    expect(assembled.options.snapshots).toBeDefined()
    expect(assembled.client.pendingReports).toBe(0)
  })

  it('lets a renewed credential replace the one the envelope carried (FR-037)', () => {
    const assembled = assemble()

    // No assertion beyond "the seam exists and does not throw": the credential is deliberately not
    // readable from the assembled object, which is the property worth keeping.
    expect(() => {
      assembled.useCredential('renewed.credential.value')
    }).not.toThrow()
  })

  it('builds a forge, which is the thing that was missing (FR-060, FR-077)', () => {
    const forge = assemble().forge

    // Exactly three methods, and none of them transitions a ticket. Asserted here as well as in
    // `delivery/forge-http.test.ts` because this is where a fourth would be wired in.
    expect(Object.keys(forge).sort()).toStrictEqual([
      'branchHead',
      'createPullRequest',
      'findPullRequest',
    ])
  })

  it('asks git for the primary entry’s host, and not until something reads it', async () => {
    const fillCredential = recordingFiller()
    const assembled = assemble({ fillCredential })

    // Nothing yet: bootstrap phase 5 has not run, so there is nothing to read.
    expect(fillCredential.calls).toStrictEqual([])

    await expect(assembled.forgeCredential.read()).resolves.toBe('forge-credential-from-the-bundle')
    expect(fillCredential.calls).toHaveLength(1)
    expect(fillCredential.calls[0].stdin).toBe('protocol=https\nhost=git.test\n\n')
  })

  it('never shows the code host the envelope’s machine-surface credential (FR-037)', async () => {
    const fillCredential = recordingFiller()
    const assembled = assemble({ fillCredential })

    await expect(assembled.forgeCredential.read()).resolves.not.toBe('scoped.credential.value')
    // Nor is it what the credential query carries.
    expect(fillCredential.calls[0].stdin).not.toContain('scoped.credential.value')
  })

  it('defaults to the agent ports, so a delegated run is dispatched rather than halted', () => {
    // Was `toBe(noWorkflowPorts)` until T194/T195/T230 landed. That assertion encoded the gap
    // rather than a requirement, and leaving it would have made the wiring that closed the gap
    // look like the regression. What matters now is only that the default is not the halt.
    expect(assemble().options.ports).not.toBe(noWorkflowPorts)
  })

  it('still halts naming the type when a run genuinely has no ports for it', async () => {
    // `noWorkflowPorts` is no longer the default, but the halt it produces is still the required
    // behaviour for the review and autonomous types, whose agent boundary is unimplemented. A stub
    // returning a plausible proposal would report success having done nothing (FR-056).
    await expect(
      dispatchWorkflow({
        workflowType: 'delegated',
        workflowId: '019fd631-15bf-7a03-a1c6-ff6d568c2654',
        source: { entryId: 'entry-a', path: '/workspace/app' },
        report: () => undefined,
        caps: { observe: () => ({ breaches: [], advisory: [] }) } as never,
        usage: () => ({ turns: 0, spendUsd: 0 }),
      }),
    ).rejects.toThrow(/delegated workflow/u)
  })
})

describe('validationModeUnsupportedError', () => {
  it('names FR-147 and states that nothing was attempted', () => {
    const error = validationModeUnsupportedError()

    expect(error.message).toContain('FR-147')
    expect(error.message).toContain('Nothing was attempted')
  })
})
