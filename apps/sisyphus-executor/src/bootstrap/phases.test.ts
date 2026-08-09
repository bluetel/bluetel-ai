import { describe, expect, it, vi } from 'vitest'

import {
  BOOTSTRAP_PHASES,
  BootstrapPhaseError,
  DEFAULT_PHASE_TIMEOUTS,
  nullPhaseReporter,
  runPhase,
  type BootstrapPhaseFinished,
  type BootstrapPhaseReporter,
  type BootstrapPhaseStarted,
} from './phases'

interface RecordingReporter extends BootstrapPhaseReporter {
  readonly started: BootstrapPhaseStarted[]
  readonly finished: BootstrapPhaseFinished[]
}

const recordingReporter = (): RecordingReporter => {
  const started: BootstrapPhaseStarted[] = []
  const finished: BootstrapPhaseFinished[] = []

  return {
    started,
    finished,
    phaseStarted: (event) => {
      started.push(event)
    },
    phaseFinished: (event) => {
      finished.push(event)
    },
  }
}

describe('phase vocabulary', () => {
  it('gives every phase in the protocol its own timeout', () => {
    for (const phase of BOOTSTRAP_PHASES) {
      expect(DEFAULT_PHASE_TIMEOUTS[phase]).toBeGreaterThan(0)
    }

    expect(Object.keys(DEFAULT_PHASE_TIMEOUTS).sort()).toEqual([...BOOTSTRAP_PHASES].sort())
  })

  it('does not give every phase the same timeout, which would defeat the point', () => {
    expect(new Set(Object.values(DEFAULT_PHASE_TIMEOUTS)).size).toBeGreaterThan(1)
    // A setup script installing a toolchain gets longer than a digest compare.
    expect(DEFAULT_PHASE_TIMEOUTS.setup_script).toBeGreaterThan(
      DEFAULT_PHASE_TIMEOUTS.bundle_verify,
    )
  })

  /**
   * The timeout map is written as a schedule, so it is checked as one. The
   * membership assertion above sorts both sides and would pass on a map that
   * listed the phases in any order at all; this one does not, which is what
   * stops the map and `BOOTSTRAP_PHASES` drifting into disagreeing about when a
   * phase runs while still agreeing that it exists.
   */
  it('lists its phases in the order the protocol runs them', () => {
    expect(Object.keys(DEFAULT_PHASE_TIMEOUTS)).toEqual([...BOOTSTRAP_PHASES])
  })

  /**
   * Position asserted by index rather than by membership (003/FR-049). A test
   * that only checked `credential_install` was present would pass with the
   * phase appended after `agent_start` — that is, with the credential installed
   * after the agent that needs it had already been started, which is the one
   * arrangement the enum's ordering exists to forbid.
   */
  it('installs the credential after the bundle and before any repository is cloned', () => {
    const at = (phase: (typeof BOOTSTRAP_PHASES)[number]) => BOOTSTRAP_PHASES.indexOf(phase)

    expect(at('setup_script')).toBeLessThan(at('credential_install'))
    expect(at('credential_install')).toBeLessThan(at('entry_checkout'))
    expect(at('credential_install')).toBeLessThan(at('agent_start'))
  })

  /**
   * A fetch and a small write, not a download or a clone. If this phase ever
   * acquires a bundle-sized budget it means it has grown work that belongs in
   * another phase.
   */
  it('budgets the credential fetch as a round trip, not as a transfer', () => {
    expect(DEFAULT_PHASE_TIMEOUTS.credential_install).toBeLessThan(
      DEFAULT_PHASE_TIMEOUTS.bundle_download,
    )
    expect(DEFAULT_PHASE_TIMEOUTS.credential_install).toBeLessThan(
      DEFAULT_PHASE_TIMEOUTS.entry_checkout,
    )
  })
})

describe('BootstrapPhaseError', () => {
  it('always names its phase in the message', () => {
    const error = new BootstrapPhaseError('bundle_unpack', 'no setup.sh at the archive root')

    expect(error.message).toBe(
      'bootstrap phase bundle_unpack failed: no setup.sh at the archive root',
    )
    expect(error.phase).toBe('bundle_unpack')
    expect(error.reason).toBe('no setup.sh at the archive root')
  })

  it('defaults to retryable, and reports a timeout as its own outcome', () => {
    expect(new BootstrapPhaseError('bundle_download', 'network').retryable).toBe(true)
    expect(new BootstrapPhaseError('bundle_download', 'network').outcome).toBe('failed')
    expect(new BootstrapPhaseError('setup_script', 'slow', { timedOut: true }).outcome).toBe(
      'timed_out',
    )
  })

  it('carries an entry id where a failure has to name one', () => {
    const error = new BootstrapPhaseError('entry_checkout', 'clone refused', { entryId: 'entry-1' })

    expect(error.entryId).toBe('entry-1')
  })
})

describe('runPhase', () => {
  it('announces the start with the timeout that will be applied', async () => {
    const reporter = recordingReporter()

    await runPhase('bundle_verify', () => Promise.resolve('ok'), { reporter })

    expect(reporter.started).toHaveLength(1)
    expect(reporter.started[0]).toMatchObject({
      phase: 'bundle_verify',
      timeoutMs: DEFAULT_PHASE_TIMEOUTS.bundle_verify,
    })
  })

  it('reports success with a measured duration', async () => {
    const reporter = recordingReporter()
    const clock = vi.fn<() => number>()

    clock.mockReturnValueOnce(1_000).mockReturnValue(1_450)

    const value = await runPhase('bundle_download', () => Promise.resolve(42), {
      reporter,
      now: clock,
    })

    expect(value).toBe(42)
    expect(reporter.finished[0]).toEqual({
      phase: 'bundle_download',
      outcome: 'succeeded',
      durationMs: 450,
    })
  })

  it('reports a failure with the phase name and the reason, not a generic error', async () => {
    const reporter = recordingReporter()

    await expect(
      runPhase(
        'setup_script',
        () => Promise.reject(new BootstrapPhaseError('setup_script', 'setup.sh exited with 3')),
        { reporter },
      ),
    ).rejects.toMatchObject({ phase: 'setup_script', reason: 'setup.sh exited with 3' })

    expect(reporter.finished[0]).toMatchObject({
      phase: 'setup_script',
      outcome: 'failed',
      detail: 'setup.sh exited with 3',
    })
  })

  it('names the phase even when the work throws something unexpected', async () => {
    const reporter = recordingReporter()
    const failure = await runPhase('bundle_unpack', () => Promise.reject(new Error('EACCES')), {
      reporter,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BootstrapPhaseError)
    expect(failure).toMatchObject({ phase: 'bundle_unpack', reason: 'EACCES' })
    expect(reporter.finished[0]?.detail).toBe('EACCES')
  })

  it('fails a phase that exceeds its own timeout, reporting timed_out (FR-146)', async () => {
    const reporter = recordingReporter()
    const failure = await runPhase('bundle_download', () => new Promise(() => undefined), {
      reporter,
      timeoutMs: 20,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BootstrapPhaseError)
    expect(failure).toMatchObject({ phase: 'bundle_download', timedOut: true })
    expect((failure as BootstrapPhaseError).message).toContain('bundle_download')
    expect(reporter.finished[0]?.outcome).toBe('timed_out')
  })

  it('aborts the work it started when the timeout fires', async () => {
    let aborted = false

    await runPhase(
      'setup_script',
      (signal) =>
        new Promise((_resolve, rejectWork) => {
          signal.addEventListener('abort', () => {
            aborted = true
            rejectWork(new Error('killed'))
          })
        }),
      { reporter: nullPhaseReporter, timeoutMs: 20 },
    ).catch(() => undefined)

    expect(aborted).toBe(true)
  })

  /**
   * 003/FR-051: a credential-install failure must fail the workflow **naming
   * that phase**. The phase's own module is T055's; what is asserted here is
   * the property that module will inherit — that there is no route by which
   * this phase produces an unattributed bootstrap failure, whether it fails on
   * its own terms, on an unexpected throw, or on its timeout.
   */
  it('names credential_install when the credential fetch fails (FR-051)', async () => {
    const reporter = recordingReporter()

    const failure = await runPhase(
      'credential_install',
      () =>
        Promise.reject(
          new BootstrapPhaseError('credential_install', 'machine surface returned 503'),
        ),
      { reporter },
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BootstrapPhaseError)
    expect((failure as BootstrapPhaseError).message).toContain('credential_install')
    expect(reporter.finished[0]).toMatchObject({
      phase: 'credential_install',
      outcome: 'failed',
      detail: 'machine surface returned 503',
    })
  })

  it('names credential_install on an unexpected throw and on its own timeout (FR-051)', async () => {
    const reporter = recordingReporter()

    const thrown = await runPhase(
      'credential_install',
      () => Promise.reject(new Error('EACCES writing agent credential file')),
      { reporter },
    ).catch((error: unknown) => error)

    expect(thrown).toMatchObject({
      phase: 'credential_install',
      reason: 'EACCES writing agent credential file',
    })

    const hung = await runPhase('credential_install', () => new Promise(() => undefined), {
      reporter,
      timeoutMs: 20,
    }).catch((error: unknown) => error)

    expect(hung).toMatchObject({ phase: 'credential_install', timedOut: true })
    expect(reporter.finished[1]?.outcome).toBe('timed_out')
  })

  it('takes the entry id off the failure when the phase was entered without one', async () => {
    const reporter = recordingReporter()

    await runPhase(
      'entry_checkout',
      () =>
        Promise.reject(
          new BootstrapPhaseError('entry_checkout', 'clone refused', { entryId: 'entry-3' }),
        ),
      { reporter },
    ).catch(() => undefined)

    // `entry_checkout` runs once for the whole workspace; FR-112 still requires
    // the failure to name the entry that broke.
    expect(reporter.started[0]?.entryId).toBeUndefined()
    expect(reporter.finished[0]?.entryId).toBe('entry-3')
  })

  it('threads an entry id through both reports', async () => {
    const reporter = recordingReporter()

    await runPhase('entry_checkout', () => Promise.resolve(undefined), {
      reporter,
      entryId: 'entry-7',
    })

    expect(reporter.started[0]?.entryId).toBe('entry-7')
    expect(reporter.finished[0]?.entryId).toBe('entry-7')
  })
})
