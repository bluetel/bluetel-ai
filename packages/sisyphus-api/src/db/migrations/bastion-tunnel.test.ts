import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { openBastionTunnel } from './bastion-tunnel'

const createFakeChild = () => {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const kill = vi.fn(() => true)
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    killed: false,
    kill,
  }) as unknown as ChildProcess & { stdout: EventEmitter; stderr: EventEmitter }

  return { child, kill }
}

describe('openBastionTunnel', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves once the tunnel reports it is waiting for connections', async () => {
    const { child, kill } = createFakeChild()
    const spawn = vi.fn(() => child)

    const promise = openBastionTunnel({
      stage: 'staging',
      adminAppDir: '/repo/apps/sisyphus-admin',
      spawn: spawn as never,
    })

    child.stdout.emit('data', Buffer.from('Tunnel\n\nWaiting for connections...\n'))

    const tunnel = await promise
    expect(spawn).toHaveBeenCalledWith(
      'pnpm',
      ['exec', 'sst', 'tunnel', '--stage', 'staging', '--print-logs'],
      expect.objectContaining({ cwd: '/repo/apps/sisyphus-admin' }),
    )

    tunnel.close()
    expect(kill).toHaveBeenCalled()
  })

  it('forwards every log line to onLog', async () => {
    const { child } = createFakeChild()
    const logged: string[] = []

    const promise = openBastionTunnel({
      stage: 'staging',
      adminAppDir: '/repo/apps/sisyphus-admin',
      spawn: (() => child) as never,
      onLog: (line) => logged.push(line),
    })

    child.stdout.emit('data', Buffer.from('starting tunnel\n'))
    child.stdout.emit('data', Buffer.from('Waiting for connections...\n'))

    await promise
    expect(logged).toEqual(['starting tunnel\n', 'Waiting for connections...\n'])
  })

  it('rejects if the process exits before becoming ready', async () => {
    const { child } = createFakeChild()

    const promise = openBastionTunnel({
      stage: 'staging',
      adminAppDir: '/repo/apps/sisyphus-admin',
      spawn: (() => child) as never,
    })

    child.emit('exit', 1)

    await expect(promise).rejects.toThrow(/exited before it was ready/)
  })

  it('rejects if the process errors before becoming ready', async () => {
    const { child } = createFakeChild()

    const promise = openBastionTunnel({
      stage: 'staging',
      adminAppDir: '/repo/apps/sisyphus-admin',
      spawn: (() => child) as never,
    })

    promise.catch(() => undefined)
    child.emit('error', new Error('ENOENT'))

    await expect(promise).rejects.toThrow(/ENOENT/)
  })

  it('rejects and kills the process if it never becomes ready in time', async () => {
    vi.useFakeTimers()
    const { child, kill } = createFakeChild()

    const promise = openBastionTunnel({
      stage: 'staging',
      adminAppDir: '/repo/apps/sisyphus-admin',
      spawn: (() => child) as never,
      readyTimeoutMs: 1000,
    })
    promise.catch(() => undefined)

    await vi.advanceTimersByTimeAsync(1000)

    await expect(promise).rejects.toThrow(/did not become ready/)
    expect(kill).toHaveBeenCalled()
  })
})
