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
