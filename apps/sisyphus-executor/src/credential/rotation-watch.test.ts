import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SecretRegistry } from '../output'
import { createSecretRegistry, sanitise } from '../output'

import type {
  CredentialFileWatcher,
  CredentialRotationAnswer,
  RotationWatchOptions,
} from './rotation-watch'
import { watchForRotation } from './rotation-watch'

/**
 * **003/T058, FR-020, FR-030, FR-032, research R3.**
 *
 * Two kinds of test here, and the split is deliberate.
 *
 * The **behavioural** ones drive a fake watcher, because what they are about is
 * the debounce, the fencing answers and the flush — decisions this module makes,
 * which a real filesystem only makes harder to observe. The **filesystem** one
 * uses a real temp directory and the real `fs.watch`, because R3's constraint is
 * about Linux behaviour and the specific thing worth proving there is that a
 * credential replaced by `rename` — a new inode at the same path, which is how a
 * careful writer replaces a secret — is still seen.
 *
 * The material is **synthetic and supplied by the fixture**. Nothing here looks
 * for a real agent login: R3 records that the location and format are
 * platform-specific and that a developer machine may hold this material in an OS
 * keychain rather than a file, so a test that depended on a real one would pass
 * or fail according to whose laptop ran it.
 */

/** Synthetic. Not a credential belonging to anything. */
const INSTALLED = 'not-a-real-agent-credential-as-installed-0001'
const ROTATED = 'not-a-real-agent-credential-after-rotation-0002'
const ROTATED_AGAIN = 'not-a-real-agent-credential-after-rotation-0003'

const scratchDirectories: string[] = []

const scratch = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'sisyphus-rotation-watch-'))
  scratchDirectories.push(directory)

  return directory
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

interface Fake {
  /** Fire a filesystem change, as the watcher would. */
  readonly change: () => void
  readonly watcher: CredentialFileWatcher
  readonly stopped: () => boolean
}

const fakeWatcher = (): Fake => {
  let notify: (() => void) | undefined
  let stopped = false

  return {
    change: () => notify?.(),
    stopped: () => stopped,
    watcher: (_path, onChange) => {
      notify = onChange

      return () => {
        stopped = true
      }
    },
  }
}

interface Harness {
  readonly reported: { fence: number; material: string }[]
  readonly failures: string[]
  readonly claimLost: () => number
  readonly secrets: SecretRegistry
  readonly fake: Fake
  readonly options: RotationWatchOptions
  file: string
}

const harnessFor = (
  answers: readonly CredentialRotationAnswer[] | (() => Promise<CredentialRotationAnswer>),
  overrides: Partial<RotationWatchOptions> = {},
): Harness => {
  const reported: { fence: number; material: string }[] = []
  const failures: string[] = []
  const secrets = createSecretRegistry()
  const fake = fakeWatcher()
  let lost = 0

  const harness: Harness = {
    reported,
    failures,
    secrets,
    fake,
    claimLost: () => lost,
    file: INSTALLED,
    options: {
      path: '/workspace/.agent-config/credentials/.credentials.json',
      fence: 12,
      secrets,
      installedMaterial: INSTALLED,
      debounceMs: 5,
      watcher: fake.watcher,
      read: () => Promise.resolve(harness.file),
      reporter: {
        reportCredentialRotation: (input) => {
          reported.push({ ...input })

          if (typeof answers === 'function') {
            return answers()
          }

          return Promise.resolve(answers[reported.length - 1] ?? { accepted: true })
        },
      },
      onFailure: (_error, detail) => {
        failures.push(detail)
      },
      onClaimLost: () => {
        lost += 1
      },
      ...overrides,
    },
  }

  return harness
}

describe('watchForRotation — debounce', () => {
  it('coalesces a burst of events into one report', async () => {
    const harness = harnessFor([{ accepted: true }])
    const watch = watchForRotation(harness.options)

    harness.file = ROTATED
    // A single rotation on Linux is a create, a write, a rename and a chmod.
    // Reading between two of them would read a half-written file.
    harness.fake.change()
    harness.fake.change()
    harness.fake.change()

    expect(harness.reported).toHaveLength(0)

    await expect(watch.flush()).resolves.toBe('reported')
    expect(harness.reported).toStrictEqual([{ fence: 12, material: ROTATED }])

    watch.stop()
  })

  it('reports a second rotation after the first was written through', async () => {
    const harness = harnessFor([{ accepted: true }, { accepted: true }])
    const watch = watchForRotation(harness.options)

    harness.file = ROTATED
    harness.fake.change()
    await watch.flush()

    harness.file = ROTATED_AGAIN
    harness.fake.change()
    await watch.flush()

    expect(harness.reported.map((entry) => entry.material)).toStrictEqual([ROTATED, ROTATED_AGAIN])

    watch.stop()
  })

  it('fires on its own once the debounce elapses, without a flush', async () => {
    vi.useFakeTimers()

    const harness = harnessFor([{ accepted: true }], { debounceMs: 50 })
    const watch = watchForRotation(harness.options)

    harness.file = ROTATED
    harness.fake.change()

    await vi.advanceTimersByTimeAsync(49)

    expect(harness.reported).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(2)

    expect(harness.reported).toHaveLength(1)

    watch.stop()
  })
})

describe('watchForRotation — what the platform already holds', () => {
  it('does not report the material credential_install just wrote', async () => {
    const harness = harnessFor([{ accepted: true }])
    const watch = watchForRotation(harness.options)

    harness.fake.change()

    await expect(watch.flush()).resolves.toBe('nothing-pending')
    expect(harness.reported).toStrictEqual([])

    watch.stop()
  })

  it('does not report a truncated read as a rotation', async () => {
    const harness = harnessFor([{ accepted: true }])
    const watch = watchForRotation(harness.options)

    // A watcher that fired between the create and the write sees an empty file.
    // Sending it would ask the platform to overwrite a working credential with
    // nothing, which is why the contract refuses an empty payload too.
    harness.file = ''
    harness.fake.change()

    await expect(watch.flush()).resolves.toBe('nothing-pending')
    expect(harness.reported).toStrictEqual([])

    watch.stop()
  })
})

describe('watchForRotation — the two rejections mean opposite things (FR-020)', () => {
  it('carries on after not_newer', async () => {
    const harness = harnessFor([{ accepted: false, reason: 'not_newer' }, { accepted: true }])
    const watch = watchForRotation(harness.options)

    harness.file = ROTATED
    harness.fake.change()

    await expect(watch.flush()).resolves.toBe('already-stored')
    expect(watch.hasLostClaim).toBe(false)
    expect(harness.claimLost()).toBe(0)
    expect(harness.fake.stopped()).toBe(false)

    // Still watching, and the next genuine rotation still goes through.
    harness.file = ROTATED_AGAIN
    harness.fake.change()

    await expect(watch.flush()).resolves.toBe('reported')
    expect(harness.reported).toHaveLength(2)

    watch.stop()
  })

  it('stops permanently after stale_fence', async () => {
    const harness = harnessFor([{ accepted: false, reason: 'stale_fence' }])
    const watch = watchForRotation(harness.options)

    harness.file = ROTATED
    harness.fake.change()

    await expect(watch.flush()).resolves.toBe('claim-lost')
    expect(watch.hasLostClaim).toBe(true)
    expect(harness.claimLost()).toBe(1)
    expect(harness.fake.stopped()).toBe(true)

    // The seat belongs to something else now. Writing to it again would either
    // be refused for the same reason for ever, or — worse, if it were not —
    // overwrite newer material with this instance's dead copy.
    harness.file = ROTATED_AGAIN
    harness.fake.change()

    await expect(watch.flush()).resolves.toBe('claim-lost')
    expect(harness.reported).toHaveLength(1)

    watch.stop()
  })

  it('treats neither rejection as a failure worth reporting as one', async () => {
    const harness = harnessFor([{ accepted: false, reason: 'stale_fence' }])
    const watch = watchForRotation(harness.options)

    harness.file = ROTATED
    harness.fake.change()
    await watch.flush()

    // A rejection is answered, not thrown, and answering it as a transport
    // failure would put the run into a retry loop against a decided refusal.
    expect(harness.failures).toStrictEqual([])

    watch.stop()
  })
})

describe('watchForRotation — an unreachable surface', () => {
  it('keeps the material pending so the next flush sends it again', async () => {
    let attempt = 0
    const harness = harnessFor(() => {
      attempt += 1

      return attempt === 1
        ? Promise.reject(new Error('machine surface unreachable'))
        : Promise.resolve({ accepted: true })
    })
    const watch = watchForRotation(harness.options)

    harness.file = ROTATED
    harness.fake.change()

    await expect(watch.flush()).resolves.toBe('failed')
    expect(harness.failures[0]).toContain('machine surface unreachable')
    expect(watch.hasLostClaim).toBe(false)

    // Nothing was recorded as stored, so the same bytes go again — this is the
    // difference between a recoverable seat and one needing re-login.
    await expect(watch.flush()).resolves.toBe('reported')
    expect(harness.reported).toHaveLength(2)

    watch.stop()
  })

  it('reports a read failure without stopping the watch', async () => {
    const harness = harnessFor([{ accepted: true }], {
      read: () => Promise.reject(new Error('EACCES opening the credential file')),
    })
    const watch = watchForRotation(harness.options)

    harness.fake.change()

    await expect(watch.flush()).resolves.toBe('failed')
    expect(harness.failures[0]).toContain('EACCES')
    expect(harness.fake.stopped()).toBe(false)

    watch.stop()
  })

  it('never rejects, whatever the surface does', async () => {
    const harness = harnessFor(() => Promise.reject(new Error('surface exploded')))
    const watch = watchForRotation(harness.options)

    harness.file = ROTATED
    harness.fake.change()

    // A suspension that failed because a credential write failed would lose the
    // snapshot too, and the snapshot is the work.
    await expect(watch.flush()).resolves.toBe('failed')

    watch.stop()
  })
})

describe('watchForRotation — material handling (FR-014, SC-014)', () => {
  it('registers rotated material as a known redaction value before reporting it', async () => {
    const registrations: string[] = []
    const harness = harnessFor(() => {
      // Sampled at the moment of the report: registering afterwards would leave
      // a window in which the newest material is live and unknown to the log.
      registrations.push(sanitise(`echo ${ROTATED}`, { secrets: harness.secrets.current }))

      return Promise.resolve({ accepted: true })
    })
    const watch = watchForRotation(harness.options)

    harness.file = ROTATED
    harness.fake.change()
    await watch.flush()

    expect(registrations[0]).not.toContain(ROTATED)
    expect(registrations[0]).toContain('[redacted:agent-credential]')

    watch.stop()
  })

  it('registers the material even when the report could not be delivered', async () => {
    const harness = harnessFor(() => Promise.reject(new Error('surface unreachable')))
    const watch = watchForRotation(harness.options)

    harness.file = ROTATED
    harness.fake.change()
    await watch.flush()

    // The bytes are on the instance whether or not the platform heard about
    // them, so the redactor has to know them whether or not the report landed.
    expect(sanitise(ROTATED, { secrets: harness.secrets.current })).toBe(
      '[redacted:agent-credential]',
    )

    watch.stop()
  })
})

describe('watchForRotation — against a real file (research R3)', () => {
  /**
   * The Linux behaviour the module is written against. A credential replaced by
   * `rename` gets a new inode at the same path, so a watch bound to the *file*
   * would go silent after the first rotation; this is the assertion that the
   * watch is on the directory instead.
   *
   * Real `fs.watch`, so the wait is a poll rather than a fixed sleep — the
   * event is delivered when the kernel delivers it.
   */
  it('sees a credential replaced by rename', async () => {
    const directory = await scratch()
    const path = join(directory, '.credentials.json')
    const reported: string[] = []

    await writeFile(path, INSTALLED)

    const watch = watchForRotation({
      path,
      fence: 12,
      secrets: createSecretRegistry(),
      installedMaterial: INSTALLED,
      debounceMs: 10,
      reporter: {
        reportCredentialRotation: (input) => {
          reported.push(input.material)

          return Promise.resolve({ accepted: true })
        },
      },
    })

    try {
      const staging = join(directory, '.credentials.json.tmp')

      await writeFile(staging, ROTATED)
      await rename(staging, path)

      const deadline = Date.now() + 4_000

      while (reported.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }

      expect(reported).toStrictEqual([ROTATED])
    } finally {
      watch.stop()
    }
  })

  it('flushes what is on disk even when no event has been observed', async () => {
    const directory = await scratch()
    const path = join(directory, '.credentials.json')
    const reported: string[] = []

    await writeFile(path, INSTALLED)

    const watch = watchForRotation({
      path,
      fence: 12,
      secrets: createSecretRegistry(),
      installedMaterial: INSTALLED,
      // Nothing will fire, which is the case being covered: a filesystem event
      // that never arrived is indistinguishable from one that has not arrived
      // yet, so the suspend flush reads regardless.
      watcher: () => () => undefined,
      reporter: {
        reportCredentialRotation: (input) => {
          reported.push(input.material)

          return Promise.resolve({ accepted: true })
        },
      },
    })

    try {
      await writeFile(path, ROTATED)

      await expect(watch.flush()).resolves.toBe('reported')
      expect(reported).toStrictEqual([ROTATED])
    } finally {
      watch.stop()
    }
  })
})
