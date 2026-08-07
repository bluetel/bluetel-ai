import type { AuthorisationDenial } from '@bluetel-ai/sisyphus-api/server'

/**
 * Where a refused request is recorded (FR-018, FR-169, FR-180).
 *
 * ## The seam, stated plainly
 *
 * **Nothing here persists anything yet.** `sisyphus-api` has no writer for authorisation denials —
 * `configuration_audit` records configuration *changes* by an admin who was allowed to make them,
 * and a refusal is neither a change nor made by an authorised actor, so writing one there would
 * corrupt the trail FR-177 and FR-184 depend on. Rather than pretend, this module logs the denial
 * and leaves one named extension point: {@link DenialWriter}.
 *
 * A later task supplies a durable writer — presumably an `authorisation_denials` table owned by
 * `sisyphus-api`, alongside the security events of SC-014 — and passes it to
 * {@link createDenialRecorder}. Until then the record is a structured log line, which is honest
 * about its durability rather than silently lossy.
 *
 * ## Why a refusal must not throw
 *
 * The contract says "failures here must not mask the refusal itself", and it means it: the
 * middleware awaits this and *then* throws the `FORBIDDEN`. A rejected promise here would replace
 * a deliberate refusal with an internal error, which turns a clean "you may not do that" into a
 * 500 and — worse — a retry loop. So every recorder swallows its own failure after reporting it.
 */

/** A durable sink for refusals. The seam the database writer will be passed through. */
export type DenialWriter = (denial: AuthorisationDenial) => Promise<void>

/** Where a recorder reports, injected so a test does not assert against the console. */
export type DenialReporter = (line: string) => void

/**
 * Render a denial as one searchable line.
 *
 * Ids only — no email, no display name, no workflow title. A refusal is an access-control event,
 * and a log that names the person and the thing they could not see has disclosed the second fact
 * to everyone with log access, which is precisely what FR-190 is about.
 */
export const formatDenial = (denial: AuthorisationDenial): string => {
  const fields: readonly (readonly [string, string | undefined])[] = [
    ['reason', denial.reason],
    ['path', denial.path],
    ['userId', denial.userId],
    ['workflowId', denial.workflowId],
    ['detail', denial.detail],
  ]

  return fields
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
}

/**
 * The writer in force today: report the line, keep nothing.
 *
 * Named rather than inlined so the thing that has to be replaced has somewhere to be replaced.
 */
export const createLoggingDenialWriter =
  (report: DenialReporter): DenialWriter =>
  (denial) => {
    report(`sisyphus.denial ${formatDenial(denial)}`)
    return Promise.resolve()
  }

/**
 * Build the `recordDenial` dependency the tRPC context is given.
 *
 * @param write - The durable sink. Defaults to {@link createLoggingDenialWriter} over `console.warn`.
 * @param report - Where a *failure of the writer itself* is reported.
 * @returns A recorder that never rejects, so a refusal is never turned into a 500.
 */
export const createDenialRecorder =
  (write: DenialWriter, report: DenialReporter): DenialWriter =>
  async (denial) => {
    try {
      await write(denial)
    } catch (error) {
      // Deliberately swallowed. The caller is mid-refusal; re-throwing would replace a `FORBIDDEN`
      // the operator can act on with an internal error they cannot.
      report(`sisyphus.denial.record-failed ${formatDenial(denial)} error=${String(error)}`)
    }
  }

/** The recorder the panel's route handler uses. One place to swap when the writer lands. */
export const recordDenial: DenialWriter = createDenialRecorder(
  createLoggingDenialWriter((line) => {
    console.warn(line)
  }),
  (line) => {
    console.warn(line)
  },
)
