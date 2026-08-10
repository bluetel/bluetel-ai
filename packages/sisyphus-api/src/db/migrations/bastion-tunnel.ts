import { spawn as nodeSpawn } from 'node:child_process'

/**
 * Opens the `sst tunnel` a migration needs to reach a stage's database.
 *
 * The database has no route from outside the VPC (see `createSisyphusVpc` in `sisyphus-infra`);
 * `sst tunnel` is the only way in, and it has to run from `apps/sisyphus-admin` because that is the
 * app whose `sst.config.ts` declares the VPC and its bastion. `sst tunnel` never prints a
 * machine-readable "ready" event, so readiness is detected by matching its own human-facing log
 * line — the same one an operator watches for when running it by hand.
 */

const READY_MARKER = 'Waiting for connections'

export interface BastionTunnel {
  /** Tears down the tunnel. Safe to call more than once. */
  readonly close: () => void
}

export interface OpenBastionTunnelOptions {
  readonly stage: string
  /** The `apps/sisyphus-admin` directory — the app that owns the VPC and its bastion. */
  readonly adminAppDir: string
  readonly readyTimeoutMs?: number
  /** Every line the tunnel process writes, for a caller that wants to show progress. */
  readonly onLog?: (line: string) => void
  /** Overridable so tests never spawn a real process. */
  readonly spawn?: typeof nodeSpawn
}

const DEFAULT_READY_TIMEOUT_MS = 60_000

export const openBastionTunnel = (options: OpenBastionTunnelOptions): Promise<BastionTunnel> => {
  const spawnProcess = options.spawn ?? nodeSpawn

  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      'pnpm',
      ['exec', 'sst', 'tunnel', '--stage', options.stage, '--print-logs'],
      { cwd: options.adminAppDir, stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let settled = false

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(
        new Error(
          `The bastion tunnel for stage "${options.stage}" did not become ready within ` +
            `${String(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)}ms.`,
        ),
      )
    }, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)

    const handleChunk = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      options.onLog?.(text)

      if (!settled && text.includes(READY_MARKER)) {
        settled = true
        clearTimeout(timeout)
        resolve({ close: () => child.kill() })
      }
    }

    child.stdout.on('data', handleChunk)
    child.stderr.on('data', handleChunk)

    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })

    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(
        new Error(
          `The bastion tunnel for stage "${options.stage}" exited before it was ready ` +
            `(code ${code === null ? 'null' : String(code)}).`,
        ),
      )
    })
  })
}
