import { execFileSync } from 'node:child_process'

/** Pull a captured stdout string off a failed child-process error, if present. */
const stdoutOf = (error: unknown): string | undefined => {
  if (typeof error === 'object' && error !== null && 'stdout' in error) {
    const { stdout } = error
    if (typeof stdout === 'string') return stdout
  }
  return undefined
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error'

/**
 * Run the `qlty` CLI and return its stdout. `qlty check` exits non-zero when it
 * finds issues but still writes SARIF to stdout, so a non-zero exit with output
 * is treated as success. A failure with no output is unrecoverable and throws.
 */
export const runQlty = (args: string[]): string => {
  try {
    return execFileSync('qlty', ['--no-upgrade-check', ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    const stdout = stdoutOf(error)
    if (stdout !== undefined) return stdout
    throw new Error(`Failed to run qlty ${args[0]}: ${messageOf(error)}`)
  }
}
