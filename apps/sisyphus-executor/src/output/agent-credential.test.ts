import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { AGENT_CREDENTIAL_SECRET_NAME, agentCredentialSecret } from './agent-credential'
import { createSecretRegistry } from './secret-registry'
import type { LogSegmentRecord, SegmentReporter, SegmentStore } from './segments'
import { createSegmentWriter } from './segments'

/**
 * **003/T054, FR-014, SC-014 — a rotation cannot reach a log even if something
 * echoes it.**
 *
 * The assertion that carries the requirement is deliberately made against the
 * **real log path** rather than against a redactor in isolation. `sanitise` is
 * easy to test and proves very little: the failure this guards against is not
 * "the redactor cannot remove a string", it is "the log was written by something
 * that did not know about this string yet". So the fixture is
 * `createSegmentWriter` — the one thing in the executor that puts agent output
 * anywhere durable — and the material is rotated *after* the writer is
 * constructed, which is exactly when a real rotation happens.
 *
 * The run is then made to echo it, twice over and in the two ways output
 * actually leaks a credential: a line the agent printed, and a base64 body it
 * quoted back out of a request. Both bodies are read out of the fake object
 * store, which is the byte sequence that would have reached S3.
 *
 * Every value here is synthetic. Nothing in this file is, resembles, or could be
 * mistaken for a credential belonging to any real service — and per research R3
 * this path is written against Linux behaviour, so nothing here reads a real
 * agent login either.
 */

const WORKFLOW_ID = '019fd631-15bf-7a03-a1c6-ff6d568c2654'

const INSTALLED = 'not-a-real-agent-credential-as-installed-0001'
const ROTATED = 'not-a-real-agent-credential-after-rotation-0002'
const BUNDLE = 'not-a-real-bundle-credential-0003'

interface Sink {
  readonly store: SegmentStore
  readonly reporter: SegmentReporter
  readonly bodies: string[]
  readonly reported: LogSegmentRecord[]
}

const createSink = (): Sink => {
  const bodies: string[] = []
  const reported: LogSegmentRecord[] = []

  return {
    bodies,
    reported,
    store: {
      put: async ({ body }) => {
        bodies.push(body)

        await Promise.resolve()
      },
    },
    reporter: {
      appendLogSegment: async (record) => {
        reported.push(record)

        await Promise.resolve()
      },
    },
  }
}

describe('agentCredentialSecret', () => {
  it('labels the placeholder without naming the seat', () => {
    expect(agentCredentialSecret(INSTALLED)).toStrictEqual({
      name: AGENT_CREDENTIAL_SECRET_NAME,
      value: INSTALLED,
    })
    expect(AGENT_CREDENTIAL_SECRET_NAME).toBe('agent-credential')
  })

  it('carries the material exactly, including a trailing newline', () => {
    // The bytes on disk are what would be echoed, so the bytes on disk are what
    // must be redacted. A helper that trimmed would know a value the file does
    // not hold.
    expect(agentCredentialSecret(`${INSTALLED}\n`).value).toBe(`${INSTALLED}\n`)
  })
})

describe('a rotation cannot reach a log (FR-014, SC-014)', () => {
  it('removes material registered after the log writer was built', async () => {
    const sink = createSink()
    const registry = createSecretRegistry([{ name: 'bundle-credential', value: BUNDLE }])

    // Built here, before either credential exists — as it is in `run/execute.ts`,
    // where reporting is armed in step 1 and `credential_install` is a bootstrap
    // phase in step 2.
    const writer = createSegmentWriter({
      workflowId: WORKFLOW_ID,
      store: sink.store,
      reporter: sink.reporter,
      secrets: registry.current,
    })

    registry.add(agentCredentialSecret(INSTALLED))

    await writer.write(`installed login is ${INSTALLED}\n`)

    // The rotation: material this process had never seen when the writer was
    // constructed, and would emit verbatim if the source were a frozen array.
    registry.add(agentCredentialSecret(ROTATED))

    await writer.write(`the agent refreshed itself: ${ROTATED}\n`)
    await writer.write(`body=${Buffer.from(`prefix${ROTATED}suffix`, 'utf8').toString('base64')}\n`)
    await writer.flush()

    const log = sink.bodies.join('')

    expect(log).not.toContain(ROTATED)
    expect(log).not.toContain(INSTALLED)
    expect(log).not.toContain(BUNDLE)
    expect(log).toContain('[redacted:agent-credential]')
    // Removed in its encoded form too, not merely verbatim: a credential quoted
    // back inside a request body is the ordinary way this leaks.
    expect(log.split('[redacted:agent-credential]')).toHaveLength(4)
    expect(sink.reported.length).toBeGreaterThan(0)
  })

  it('removes material split across two writes, after a rotation widened the window', async () => {
    const sink = createSink()
    const registry = createSecretRegistry()
    const writer = createSegmentWriter({
      workflowId: WORKFLOW_ID,
      store: sink.store,
      reporter: sink.reporter,
      secrets: registry.current,
    })

    registry.add(agentCredentialSecret(ROTATED))

    // The half-and-half case the streaming redactor's hold-back exists for. It
    // only works if the hold-back grew when the rotation was registered, which
    // is why `createStreamingRedactor` reads the window per chunk rather than
    // caching it at construction.
    await writer.write(`echo ${ROTATED.slice(0, 12)}`)
    await writer.write(`${ROTATED.slice(12)} done\n`)
    await writer.flush()

    const log = sink.bodies.join('')

    expect(log).not.toContain(ROTATED)
    expect(log).toContain('[redacted:agent-credential]')
  })

  it('leaves the log alone when no credential has been installed yet', async () => {
    const sink = createSink()
    const registry = createSecretRegistry()
    const writer = createSegmentWriter({
      workflowId: WORKFLOW_ID,
      store: sink.store,
      reporter: sink.reporter,
      secrets: registry.current,
    })

    await writer.write('bootstrap: bundle_download started\n')
    await writer.flush()

    expect(sink.bodies.join('')).toBe('bootstrap: bundle_download started\n')
  })
})
