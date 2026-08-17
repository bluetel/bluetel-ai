/**
 * `cli.test.ts` exists because Constitution III admits no exception for an entry point.
 * `parseArgs` is a pure function over argv, so the whole contract in `contracts/cli.md` is
 * assertable without spawning a process.
 */
import { describe, expect, it } from 'vitest'

import { parseArgs } from './cli'

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
