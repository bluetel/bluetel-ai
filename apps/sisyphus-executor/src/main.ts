/**
 * **The executor's entry point (T173, FR-203).**
 *
 * `build.mjs` bundles this file and `project.json`'s `dev` target runs it, so this is the whole of
 * what a provisioned instance does. It is deliberately the thinnest file in the app: it reads the
 * job envelope, hands it to {@link assembleRun}, runs it, and turns the outcome into an exit code.
 * Every decision worth testing lives in `src/run/`, in modules with colocated tests — an assembly
 * that can only be exercised by launching an instance is an assembly nobody checks, which is the
 * condition FR-203 exists to name.
 *
 * ## How the envelope reaches the process
 *
 * As text, on a path given as the first argument, or on stdin. It is **not** read from the
 * environment, and no job parameter is (`env-schemas.ts` explains why that boundary is
 * load-bearing): the instance's launch unit is what puts user-data in front of this process, which
 * keeps the credential out of every child process's environment — including whatever `setup.sh`
 * and the agent run.
 *
 * ## Exit codes
 *
 * `0` for a run that reached a terminal outcome and reported it, whatever that outcome was — a
 * capped run and a failed run are both runs that worked, and a non-zero exit would tell the
 * instance's supervisor to restart something that has already reported its result. `1` is reserved
 * for the case where the run could not report at all: an unusable envelope, or an assembly that
 * threw before the reporting path was armed. That is the only condition an operator has to look at
 * the instance's own logs for.
 */

import process from 'node:process'

import { env } from './env'
import { parseJobEnvelope } from './job-envelope'
import { assembleRun, assembleValidation, runExecutor, runValidation } from './run'
import { createShutdownRegistry } from './runtime'

/**
 * Read the envelope text.
 *
 * @param argv - `process.argv.slice(2)`. A path, or nothing to read stdin.
 * @param stdin - The stream to fall back to.
 */
export const readEnvelopeText = async (
  argv: readonly string[],
  stdin: AsyncIterable<Uint8Array | string>,
): Promise<string> => {
  const path = argv.at(0)

  if (path !== undefined && path !== '-') {
    const { readFile } = await import('node:fs/promises')

    return readFile(path, 'utf8')
  }

  const chunks: string[] = []

  for await (const chunk of stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
  }

  return chunks.join('')
}

const main = async (): Promise<void> => {
  const registry = createShutdownRegistry()

  // Both signals converge on the one ordered cleanup, run exactly once. Registered before anything
  // else so a SIGTERM arriving during assembly still tears down whatever was built.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void registry.shutdown({ source: signal }).then(({ errors }) => {
        process.exitCode = errors.length > 0 ? 1 : 0
      })
    })
  }

  const envelope = parseJobEnvelope(await readEnvelopeText(process.argv.slice(2), process.stdin))

  if (envelope.mode === 'validation') {
    // A validation is a different run, not a degenerate workflow: bootstrap phases 2–5 against the
    // archive, one report, exit (T200, FR-147). It used to throw here, because the machine surface
    // had no procedure a run without a workflow could report to; `machine.reportValidation` is that
    // procedure and `src/run/validate.ts` is what reaches it.
    const environment = {
      region: env.AWS_REGION,
      machineSurfaceUrl: env.SISYPHUS_MACHINE_SURFACE_URL,
      bundlesBucket: env.SISYPHUS_BUNDLES_BUCKET,
      logsBucket: env.SISYPHUS_LOGS_BUCKET,
      workspaceRoot: env.SISYPHUS_WORKSPACE_ROOT,
    }

    const validation = await runValidation({
      envelope,
      environment,
      ...assembleValidation({ envelope, environment }),
      onOutputFailure: (error: unknown) => {
        process.stderr.write(
          `[executor] the captured setup output could not be stored: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        )
      },
    })

    // Exit 0 for a validation that reported, whatever it found. A bundle that fails at its first
    // phase is a validation that worked; a non-zero exit would tell the instance's supervisor to
    // restart something that has already delivered its result. The only path to 1 is the outer
    // `catch`, which is reached when the report itself could not be delivered.
    process.stdout.write(`[executor] validation ${validation.report.outcome}\n`)
    process.exitCode = 0

    return
  }

  const assembled = assembleRun({
    envelope,
    environment: {
      region: env.AWS_REGION,
      machineSurfaceUrl: env.SISYPHUS_MACHINE_SURFACE_URL,
      forgeApiUrl: env.SISYPHUS_FORGE_API_URL,
      bundlesBucket: env.SISYPHUS_BUNDLES_BUCKET,
      logsBucket: env.SISYPHUS_LOGS_BUCKET,
      snapshotsBucket: env.SISYPHUS_SNAPSHOTS_BUCKET,
      workspaceRoot: env.SISYPHUS_WORKSPACE_ROOT,
    },
    shutdown: registry,
    onReportingFailure: (error, detail) => {
      // The one place this process writes to its own stderr. Reporting failures are transient by
      // definition (FR-047) and must not end a run that is otherwise working, but a run that spent
      // an hour unable to reach the surface should leave a trace on the instance.
      process.stderr.write(
        `[executor] ${detail}: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    },
  })

  const result = await runExecutor(assembled.options)

  // Reported, so the outcome is on the record whatever happens next; written here too because an
  // instance's console is the only thing an operator has when the surface was unreachable.
  process.stdout.write(`[executor] ${result.outcome}: ${result.reason}\n`)
  process.exitCode = 0
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[executor] the run could not be started or could not report: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  )
  process.exitCode = 1
})
