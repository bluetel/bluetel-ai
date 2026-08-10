import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import { afterEach, describe, expect, it } from 'vitest'

import { runCommand } from './bootstrap/run-command'
import {
  AMBIENT_GIT_VARIABLES,
  GIT_FIXTURE_ENVIRONMENT,
  gitFixtureEnvironment,
  stripAmbientGitEnvironment,
} from './git-fixture-environment'

/**
 * The test-support module's own suite.
 *
 * Two of these assertions are the point of the module rather than descriptions of it: that a
 * `GIT_DIR` in `process.env` really does capture a fixture's `git init` — the failure observed
 * under `.husky/pre-commit` — and that the strip really does stop it. Everything else here would
 * still pass if the module quietly did nothing.
 */

const scratchDirectories: string[] = []

const scratch = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'sisyphus-git-fixture-env-'))

  scratchDirectories.push(directory)

  return directory
}

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)

    return true
  } catch {
    return false
  }
}

describe('stripAmbientGitEnvironment', () => {
  it('removes every ambient variable and puts back exactly what it took', () => {
    const env: NodeJS.ProcessEnv = {
      GIT_DIR: '/somewhere/.git',
      GIT_INDEX_FILE: '/somewhere/.git/index',
      PATH: '/usr/bin',
    }

    const restore = stripAmbientGitEnvironment(env)

    expect(env).toStrictEqual({ PATH: '/usr/bin' })

    restore()

    expect(env).toStrictEqual({
      GIT_DIR: '/somewhere/.git',
      GIT_INDEX_FILE: '/somewhere/.git/index',
      PATH: '/usr/bin',
    })
  })

  it('leaves a variable that was already absent absent, rather than restoring it as a string', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }

    stripAmbientGitEnvironment(env)()

    expect(Object.keys(env)).toStrictEqual(['PATH'])
  })

  it('names the variables git exports into a hook process', () => {
    // The two the observed `pre-commit` failure turned on, asserted by name so that shortening the
    // list is a deliberate edit rather than a tidy-up.
    expect(AMBIENT_GIT_VARIABLES).toContain('GIT_DIR')
    expect(AMBIENT_GIT_VARIABLES).toContain('GIT_INDEX_FILE')
    expect(AMBIENT_GIT_VARIABLES).toContain('GIT_COMMON_DIR')
    expect(AMBIENT_GIT_VARIABLES).toContain('GIT_WORK_TREE')
  })
})

describe('gitFixtureEnvironment', () => {
  it('drops the ambient variables and supplies the fixture identity', () => {
    process.env.GIT_DIR = '/somewhere/.git'

    try {
      const env = gitFixtureEnvironment()

      expect(env.GIT_DIR).toBeUndefined()
      expect(env.GIT_AUTHOR_EMAIL).toBe(GIT_FIXTURE_ENVIRONMENT.GIT_AUTHOR_EMAIL)
      expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    } finally {
      delete process.env.GIT_DIR
    }
  })

  it('lets one invocation add to it without losing the strip', () => {
    process.env.GIT_INDEX_FILE = '/somewhere/.git/index'

    try {
      const env = gitFixtureEnvironment({ GIT_SSH_COMMAND: 'sleep 30' })

      expect(env.GIT_INDEX_FILE).toBeUndefined()
      expect(env.GIT_SSH_COMMAND).toBe('sleep 30')
    } finally {
      delete process.env.GIT_INDEX_FILE
    }
  })
})

describe('a fixture repository built under an ambient GIT_DIR', () => {
  /**
   * The whole reason this module exists, stated as a test.
   *
   * `runCommand` spawns with `{ ...process.env, ...options.env }`, so an ambient `GIT_DIR` reaches
   * the child no matter what the caller passes — `git init` then initialises *that* directory and
   * the fixture's own path is never created. The second case is the same fixture with the strip
   * applied, and it is the one that has to pass from inside a git hook.
   */
  it('is captured by the ambient repository without the strip', async () => {
    const elsewhere = join(await scratch(), 'elsewhere')
    const fixture = join(await scratch(), 'fixture')

    process.env.GIT_DIR = elsewhere

    try {
      const result = await runCommand({
        command: 'git',
        args: ['init', '--initial-branch', 'main', fixture],
        env: GIT_FIXTURE_ENVIRONMENT,
      })

      expect(result.exitCode).toBe(0)
      // The fixture directory was named on the command line and is not what git wrote to.
      expect(await exists(join(fixture, '.git'))).toBe(false)
      expect(await exists(elsewhere)).toBe(true)
    } finally {
      delete process.env.GIT_DIR
    }
  })

  it('is built where it was asked to be once the strip has run', async () => {
    const elsewhere = join(await scratch(), 'elsewhere')
    const fixture = join(await scratch(), 'fixture')

    process.env.GIT_DIR = elsewhere
    const restore = stripAmbientGitEnvironment()

    try {
      const result = await runCommand({
        command: 'git',
        args: ['init', '--initial-branch', 'main', fixture],
        env: GIT_FIXTURE_ENVIRONMENT,
      })

      expect(result.exitCode, `git init: ${result.output}`).toBe(0)
      expect(await exists(join(fixture, '.git'))).toBe(true)
      expect(await exists(elsewhere)).toBe(false)
    } finally {
      restore()
      delete process.env.GIT_DIR
    }
  })
})
