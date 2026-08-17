/**
 * `cli.test.ts` exists because Constitution III admits no exception for an entry point.
 * `parseArgs` is a pure function over argv, so the whole contract in `contracts/cli.md` is
 * assertable without spawning a process.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseArgs, runCli } from './cli'
import type * as GateModule from './gate'

import { configurableRules, EXIT, RULES, type GateIo, type GateOptions } from '.'

/**
 * Every call the command makes into the gate, in order.
 *
 * "Evaluates no artifacts" cannot be read off an exit code: a `--list-rules` that ran the
 * whole gate and threw the outcome away would exit `0` with an identical stdout. So the
 * real module is wrapped rather than replaced — the runs below still evaluate for real —
 * and entering it at all is recorded.
 */
const { gateCalls } = vi.hoisted(() => ({ gateCalls: [] as GateOptions[] }))

vi.mock('./gate', async (importOriginal) => {
  const actual = await importOriginal<typeof GateModule>()
  return {
    ...actual,
    runPromptLintGate: (options: GateOptions) => {
      gateCalls.push(options)
      return actual.runPromptLintGate(options)
    },
  }
})

const parse = (...argv: string[]) => parseArgs(argv)

/** Narrow to a successful parse, failing the test with the message if it was a usage error. */
const run = (...argv: string[]) => {
  const parsed = parse(...argv)
  if (parsed.kind !== 'run') throw new Error(`expected a run, got ${parsed.kind}`)
  return parsed
}

const usageError = (...argv: string[]): string => {
  const parsed = parse(...argv)
  if (parsed.kind !== 'usage-error') throw new Error(`expected a usage error, got ${parsed.kind}`)
  return parsed.message
}

describe('parseArgs', () => {
  it('defaults to diff mode with no base ref, deferring to config.defaultBaseRef', () => {
    expect(run().options).toMatchObject({ mode: 'diff', applyBaseline: true })
    expect(run().options.baseRef).toBeUndefined()
    expect(run().maxFindings).toBe(25)
  })

  it('reads a positional base ref', () => {
    expect(run('origin/staging').options).toMatchObject({ mode: 'diff', baseRef: 'origin/staging' })
  })

  it('switches to whole-repository scope on --all', () => {
    expect(run('--all').options.mode).toBe('all')
  })

  it('switches to the staged set on --staged — the pre-commit path', () => {
    expect(run('--staged').options.mode).toBe('staged')
  })

  it('accepts --no-baseline', () => {
    expect(run('--no-baseline').options.applyBaseline).toBe(false)
  })

  it('accepts each named scope subset', () => {
    for (const subset of ['catalog', 'installed', 'guidance', 'speckit']) {
      expect(run(`--scope=${subset}`).options.subset).toBe(subset)
    }
  })

  it('accepts --max-findings', () => {
    expect(run('--max-findings=3').maxFindings).toBe(3)
    expect(run('--max-findings=0').maxFindings).toBe(0)
  })

  describe('usage errors (exit 2)', () => {
    it('rejects an unknown flag rather than ignoring it', () => {
      // An ignored `--json` in CI looks like a tool that produces the wrong output rather
      // than one that was called wrong.
      expect(usageError('--jsn')).toContain("unknown flag '--jsn'")
    })

    it('rejects mutually exclusive scopes rather than silently resolving a precedence', () => {
      expect(usageError('--all', '--staged')).toContain('mutually exclusive')
      expect(usageError('--all', 'origin/main')).toContain('mutually exclusive')
      expect(usageError('--staged', 'origin/main')).toContain('mutually exclusive')
    })

    it('names both scopes it refused', () => {
      const message = usageError('--all', '--staged')
      expect(message).toContain('--all')
      expect(message).toContain('--staged')
    })

    it('rejects two base refs', () => {
      expect(usageError('origin/main', 'origin/staging')).toContain('two base refs')
    })

    it('rejects an unknown --scope, listing the ones that exist', () => {
      const message = usageError('--scope=everything')
      expect(message).toContain("unknown --scope 'everything'")
      expect(message).toContain('catalog, installed, guidance, speckit')
    })

    it('rejects a non-integer or negative --max-findings', () => {
      expect(usageError('--max-findings=lots')).toContain('non-negative integer')
      expect(usageError('--max-findings=-1')).toContain('non-negative integer')
      expect(usageError('--max-findings=1.5')).toContain('non-negative integer')
    })

    it('rejects an unknown --explain target', () => {
      expect(usageError('--explain=refs/renamed-away')).toContain('unknown rule')
    })

    it('rejects --explain with no rule id', () => {
      expect(usageError('--explain=')).toContain('expects a rule id')
    })

    it('rejects --list-rules together with --explain', () => {
      expect(usageError('--list-rules', '--explain=refs/dangling-path')).toContain(
        'mutually exclusive',
      )
    })

    it('rejects the Phase D flags that do not exist yet rather than accepting them as no-ops', () => {
      // Accepting `--rules-only` while the delegated half is unbuilt would report a run
      // that skipped nothing as a run that skipped something.
      for (const flag of ['--json', '--rules-only', '--bundle=guidance']) {
        expect(usageError(flag)).toContain('unknown flag')
      }
    })
  })

  describe('the self-describing commands', () => {
    it('parses --list-rules, which evaluates no artifacts', () => {
      expect(parse('--list-rules').kind).toBe('list-rules')
    })

    it('parses --explain for a rule that exists', () => {
      expect(parse('--explain=refs/dangling-path')).toEqual({
        kind: 'explain',
        ruleId: 'refs/dangling-path',
      })
    })

    it('parses --explain for a bookkeeping rule too', () => {
      expect(parse('--explain=artifact/unreadable').kind).toBe('explain')
    })
  })
})

/** Collect what the command wrote, so stdout and stderr can be asserted separately. */
const sink = (): { io: GateIo; stdout: string[]; stderr: string[] } => {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    io: {
      out: (message) => {
        stdout.push(message)
      },
      err: (message) => {
        stderr.push(message)
      },
    },
    stdout,
    stderr,
  }
}

/**
 * `runCli` is where "exits 0" and "evaluates no artifacts" are two different claims, and
 * the second is the one T042 is about. Asserting the exit code alone would pass for a
 * `--list-rules` that evaluated the whole repository first and then printed a catalogue.
 *
 * Two sensors, because each covers what the other misses. `gateCalls` records entry into
 * the gate, so a run whose outcome is discarded is still visible. And the `repoRoot` is a
 * directory that exists and is **not** a git repository, so any run that does reach the
 * gate fails against it with exit `4` and a message on stderr — which is what makes exit
 * `0` and a silent stderr mean something. The first test is the control for the second.
 */
describe('runCli', () => {
  const notARepository = mkdtempSync(join(tmpdir(), 'prompt-lint-cli-'))

  beforeEach(() => {
    gateCalls.length = 0
  })

  afterAll(() => {
    rmSync(notARepository, { recursive: true, force: true })
  })

  it('enters the gate for a plain run, and fails loudly on that root — the control', () => {
    const { io, stdout, stderr } = sink()
    expect(runCli([], io, notARepository)).toBe(EXIT.scope)
    expect(gateCalls).toHaveLength(1)
    expect(gateCalls[0]).toMatchObject({ mode: 'diff', repoRoot: notARepository })
    expect(stderr.join('\n')).toContain('is not a git repository')
    expect(stdout).toEqual([])
  })

  it('evaluates no artifacts for --list-rules, and exits 0 (FR-006)', () => {
    const { io, stdout, stderr } = sink()
    expect(runCli(['--list-rules'], io, notARepository)).toBe(EXIT.ok)
    expect(gateCalls).toEqual([])
    expect(stderr).toEqual([])
    expect(stdout[0]).toBe(`prompt-lint: ${String(RULES.length)} rules`)
    expect(stdout.join('\n')).toContain(
      `${String(configurableRules().length)} of ${String(RULES.length)} have a configurable severity`,
    )
  })

  it('evaluates no artifacts for --explain, and exits 0', () => {
    const { io, stdout, stderr } = sink()
    expect(runCli(['--explain=refs/dangling-path'], io, notARepository)).toBe(EXIT.ok)
    expect(gateCalls).toEqual([])
    expect(stderr).toEqual([])
    expect(stdout[0]).toBe('refs/dangling-path')
    expect(stdout.join('\n')).toContain('what   ')
  })

  it('evaluates no artifacts for --list-rules even when a scope was also passed', () => {
    // The self-describing commands short-circuit: `--all` would otherwise establish scope
    // over the whole declared set before anything was printed.
    const { io, stderr } = sink()
    expect(runCli(['--list-rules', '--all'], io, notARepository)).toBe(EXIT.ok)
    expect(gateCalls).toEqual([])
    expect(stderr).toEqual([])
  })

  it('exits 2 for an unknown --explain target, having evaluated nothing', () => {
    const { io, stdout, stderr } = sink()
    expect(runCli(['--explain=refs/renamed-away'], io, notARepository)).toBe(EXIT.usage)
    expect(gateCalls).toEqual([])
    expect(stderr.join('\n')).toContain("unknown rule 'refs/renamed-away'")
    expect(stdout).toEqual([])
  })

  it('exits 2 for an unknown flag, naming the flag rather than ignoring it', () => {
    const { io, stdout, stderr } = sink()
    expect(runCli(['--jsn'], io, notARepository)).toBe(EXIT.usage)
    expect(gateCalls).toEqual([])
    expect(stderr.join('\n')).toContain("prompt-lint: unknown flag '--jsn'")
    expect(stdout).toEqual([])
  })

  it('accepts --no-baseline: it reaches the gate, carrying the flag, rather than being refused', () => {
    // Exit 4 rather than 2 is half the assertion — the flag was understood. The other half
    // is that it arrived: a flag parsed and then dropped on the floor is the failure an
    // accepted-but-inert flag actually looks like.
    const { io, stderr } = sink()
    expect(runCli(['--no-baseline', '--all'], io, notARepository)).toBe(EXIT.scope)
    expect(gateCalls[0]).toMatchObject({ mode: 'all', applyBaseline: false })
    expect(stderr.join('\n')).toContain('is not a git repository')
  })
})
