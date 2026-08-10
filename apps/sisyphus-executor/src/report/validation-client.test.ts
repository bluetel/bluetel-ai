import { describe, expect, it, vi } from 'vitest'

import type { SanitisedText } from '../output'

import type { Sleeper } from './backoff'
import type {
  ValidationReportResult,
  ValidationRunReport,
  ValidationSurfaceTransport,
} from './validation-client'
import { createValidationSurfaceClient, VALIDATION_REPORT_ATTEMPTS } from './validation-client'

/**
 * The one call a validation makes (T200, FR-147).
 *
 * Nothing here opens a socket: the transport is the seam, and `createHttpValidationTransport` is the
 * only thing in the module that touches HTTP.
 */

const recorded: ValidationReportResult = {
  validationRunId: '01890a5d-ac96-774b-bcce-b302099a9001',
  outcome: 'passed',
  run: null,
  alreadyRecorded: false,
}

const report: ValidationRunReport = {
  phaseResults: [
    { phase: 'provisioning', outcome: 'succeeded' },
    { phase: 'setup_script', outcome: 'failed', detail: 'exit 1' as SanitisedText },
  ],
  outputS3Key: 'validations/abc/def.txt',
}

/** Never waits. The schedule is `backoff.ts`'s to prove; this file is about the loop. */
const instantly = async (): Promise<void> => Promise.resolve()

describe('reporting a validation result', () => {
  it('delivers the report and answers what the surface recorded', async () => {
    const reportValidation = vi.fn(() => Promise.resolve(recorded))
    const client = createValidationSurfaceClient({
      transport: { reportValidation } satisfies ValidationSurfaceTransport,
      sleep: instantly,
    })

    await expect(client.reportValidation(report)).resolves.toStrictEqual(recorded)
    expect(reportValidation).toHaveBeenCalledExactlyOnceWith(report)
  })

  it('retries an unreachable surface rather than losing the run’s only product (FR-047)', async () => {
    // A validation whose report is lost is indistinguishable from one whose executor died, and the
    // control plane writes a `timed_out` over it 45 minutes later. Retrying is the difference
    // between a proof and a silence.
    const onRetry = vi.fn<(attempt: number, error: unknown) => void>()
    const reportValidation = vi
      .fn<ValidationSurfaceTransport['reportValidation']>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce(recorded)

    const client = createValidationSurfaceClient({
      transport: { reportValidation },
      sleep: instantly,
      onRetry,
    })

    await expect(client.reportValidation(report)).resolves.toStrictEqual(recorded)
    expect(reportValidation).toHaveBeenCalledTimes(3)
    expect(onRetry.mock.calls.map(([attempt]) => attempt)).toStrictEqual([1, 2])
  })

  it('waits the schedule’s delay between attempts, and not after the last one', async () => {
    const sleep = vi.fn<Sleeper>(async () => Promise.resolve())
    const reportValidation = vi
      .fn<ValidationSurfaceTransport['reportValidation']>()
      .mockRejectedValue(new Error('down'))

    await expect(
      createValidationSurfaceClient({
        transport: { reportValidation },
        attempts: 3,
        backoff: { delayFor: (attempt) => attempt * 100 },
        sleep,
      }).reportValidation(report),
    ).rejects.toThrow()

    expect(reportValidation).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toStrictEqual([100, 200])
  })

  it('gives up loudly, naming FR-147 and the last failure', async () => {
    // Silence here would be the worst outcome: the run happened, the bundle was proved, and nobody
    // upstream can see either. The rejection is what makes `main.ts` exit non-zero.
    const client = createValidationSurfaceClient({
      transport: { reportValidation: () => Promise.reject(new Error('the surface is gone')) },
      attempts: 2,
      sleep: instantly,
    })

    await expect(client.reportValidation(report)).rejects.toThrow(
      /could not be reported after 2 attempts.*FR-147.*the surface is gone/su,
    )
  })

  it('attempts more than once by default', () => {
    expect(VALIDATION_REPORT_ATTEMPTS).toBeGreaterThan(1)
  })
})
