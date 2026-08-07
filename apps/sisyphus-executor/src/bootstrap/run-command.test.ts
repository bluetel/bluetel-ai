/* cspell:ignore AKIAIOSFODNN EXAMPLEKEY mred -- fixture noise: a fake key prefix, and an ANSI escape that splits "red" */

import { describe, expect, it } from 'vitest'

import { describeExit, runCommand } from './run-command'

describe('runCommand', () => {
  it('captures stdout and stderr together, in one sanitised result', async () => {
    const result = await runCommand({
      command: 'sh',
      args: ['-c', 'echo out; echo err 1>&2'],
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('out')
    expect(result.output).toContain('err')
  })

  it('reports a non-zero exit rather than throwing', async () => {
    const result = await runCommand({ command: 'sh', args: ['-c', 'exit 3'] })

    expect(result.exitCode).toBe(3)
    expect(describeExit(result)).toBe('exited with code 3')
  })

  it('redacts a credential the script echoed, before it reaches the caller (FR-089)', async () => {
    const secret = 'AKIAIOSFODNN7EXAMPLEKEY'
    const result = await runCommand({
      command: 'sh',
      args: ['-c', `echo "installed token ${secret}"`],
      secrets: [{ name: 'repo-token', value: secret }],
    })

    expect(result.output).not.toContain(secret)
    expect(result.output).toContain('[redacted:repo-token]')
  })

  it('strips control sequences, so a progress bar is not persisted as noise', async () => {
    const result = await runCommand({
      command: 'sh',
      args: ['-c', 'printf "plain \\033[31mred\\033[0m\\n"'],
    })

    expect(result.output).toContain('plain red')
    expect(result.output).not.toContain('[31m')
  })

  it('streams sanitised output as it is produced', async () => {
    const seen: string[] = []

    await runCommand({
      command: 'sh',
      args: ['-c', 'echo one; echo two'],
      onOutput: (text) => seen.push(text),
    })

    expect(seen.join('')).toContain('one')
    expect(seen.join('')).toContain('two')
  })

  it('passes the environment the script is promised', async () => {
    const result = await runCommand({
      command: 'sh',
      args: ['-c', 'echo "root=$SISYPHUS_WORKSPACE_ROOT"'],
      env: { SISYPHUS_WORKSPACE_ROOT: '/workspace' },
    })

    expect(result.output).toContain('root=/workspace')
  })

  it('writes stdin and closes it, so a filter command terminates', async () => {
    const result = await runCommand({
      command: 'cat',
      stdin: new TextEncoder().encode('piped bytes\n'),
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('piped bytes')
  })

  it('kills the process group when the phase signal aborts', async () => {
    const controller = new AbortController()
    const running = runCommand({
      command: 'sh',
      args: ['-c', 'sleep 30'],
      signal: controller.signal,
    })

    setTimeout(() => controller.abort(), 50)

    const result = await running

    expect(result.aborted).toBe(true)
    expect(result.signal).toBe('SIGKILL')
    expect(describeExit(result)).toBe('was killed by SIGKILL')
  }, 20_000)

  it('kills a child that outlives its parent shell', async () => {
    const controller = new AbortController()
    const running = runCommand({
      // The inner `sleep` is a separate process; signalling only the shell
      // would leave it running. The group kill is what takes it with us.
      command: 'sh',
      args: ['-c', 'sleep 30 & wait'],
      signal: controller.signal,
    })

    setTimeout(() => controller.abort(), 50)

    expect((await running).aborted).toBe(true)
  }, 20_000)

  it('rejects when the command does not exist', async () => {
    await expect(runCommand({ command: 'sisyphus-no-such-command-at-all' })).rejects.toThrow()
  })
})
