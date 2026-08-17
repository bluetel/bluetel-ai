#!/usr/bin/env tsx
/**
 * argv → gate → exit code. Mirrors `qlty:diff`: the first positional argument is the base
 * ref, `--all` switches to whole-repository scope.
 *
 * Every parse failure is a **usage error (exit 2)**, never a silently-resolved precedence
 * and never an ignored flag — an ignored `--json` in CI looks like a tool that produces
 * the wrong output rather than one that was called wrong.
 *
 * Usage:
 *   tsx src/cli.ts                     # diff vs config.defaultBaseRef
 *   tsx src/cli.ts origin/staging      # diff vs an explicit base ref
 *   tsx src/cli.ts --all               # every artifact in the declared set
 *   tsx src/cli.ts --staged            # the staged set (the pre-commit path)
 *   tsx src/cli.ts --list-rules
 *   tsx src/cli.ts --explain=refs/dangling-path
 */
import process from 'node:process'

import { isScopeSubset, SUBSET_NAMES, type ScopeSubset } from './scope'

import {
  configurableRules,
  EXIT,
  renderHuman,
  renderRuleExplanation,
  renderRuleList,
  ruleById,
  RULES,
  runPromptLintGate,
  type ExitCode,
  type GateIo,
  type GateOptions,
} from '.'

const DEFAULT_MAX_FINDINGS = 25

export type ParseResult =
  | { kind: 'run'; options: Omit<GateOptions, 'repoRoot'>; maxFindings: number }
  | { kind: 'list-rules' }
  | { kind: 'explain'; ruleId: string }
  | { kind: 'usage-error'; message: string }

const usage = (message: string): ParseResult => ({ kind: 'usage-error', message })

/** Parse `--name=value`, returning null when the flag is not of that form. */
const valueOf = (arg: string, name: string): string | null =>
  arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : null

/**
 * Parse argv. Exported so `cli.test.ts` can assert the contract without spawning a
 * process — Constitution III admits no exception for an entry point.
 */
export const parseArgs = (argv: readonly string[]): ParseResult => {
  let all = false
  let staged = false
  let baseRef: string | undefined
  let subset: ScopeSubset | undefined
  let maxFindings = DEFAULT_MAX_FINDINGS
  let applyBaseline = true
  let listRules = false
  let explain: string | undefined

  for (const arg of argv) {
    if (arg === '--all') {
      all = true
      continue
    }
    if (arg === '--staged') {
      staged = true
      continue
    }
    if (arg === '--no-baseline') {
      applyBaseline = false
      continue
    }
    if (arg === '--list-rules') {
      listRules = true
      continue
    }

    const explainValue = valueOf(arg, '--explain')
    if (explainValue !== null) {
      explain = explainValue
      continue
    }

    const scopeValue = valueOf(arg, '--scope')
    if (scopeValue !== null) {
      if (!isScopeSubset(scopeValue)) {
        return usage(
          `unknown --scope '${scopeValue}'. Expected one of: ${SUBSET_NAMES.join(', ')}.`,
        )
      }
      subset = scopeValue
      continue
    }

    const maxValue = valueOf(arg, '--max-findings')
    if (maxValue !== null) {
      const parsed = Number(maxValue)
      if (!Number.isInteger(parsed) || parsed < 0) {
        return usage(`--max-findings expects a non-negative integer, got '${maxValue}'.`)
      }
      maxFindings = parsed
      continue
    }

    if (arg.startsWith('-')) return usage(`unknown flag '${arg}'.`)

    if (baseRef !== undefined) {
      return usage(`two base refs given ('${baseRef}' and '${arg}'); expected at most one.`)
    }
    baseRef = arg
  }

  if (listRules && explain !== undefined) {
    return usage('--list-rules and --explain are mutually exclusive.')
  }
  if (listRules) return { kind: 'list-rules' }
  if (explain !== undefined) {
    if (explain.length === 0) return usage('--explain expects a rule id.')
    if (ruleById(explain) === undefined) {
      return usage(`unknown rule '${explain}'. Run --list-rules to see the catalogue.`)
    }
    return { kind: 'explain', ruleId: explain }
  }

  // Mutually exclusive rather than silently resolved: a caller who passed two scopes does
  // not know which one they got, and the one they got is the one that will surprise them.
  const scopes = [
    all && '--all',
    staged && '--staged',
    baseRef !== undefined && 'a base ref',
  ].filter((label): label is string => typeof label === 'string')
  if (scopes.length > 1) {
    return usage(`${scopes.join(' and ')} are mutually exclusive; pass one scope.`)
  }

  return {
    kind: 'run',
    maxFindings,
    options: {
      mode: all ? 'all' : staged ? 'staged' : 'diff',
      ...(baseRef === undefined ? {} : { baseRef }),
      ...(subset === undefined ? {} : { subset }),
      applyBaseline,
      rulesOnly: true,
    },
  }
}

/** Run the parsed command. Separated from `parseArgs` so each is testable alone. */
export const runCli = (argv: readonly string[], io: GateIo, repoRoot: string): ExitCode => {
  const parsed = parseArgs(argv)

  if (parsed.kind === 'usage-error') {
    io.err(`prompt-lint: ${parsed.message}`)
    return EXIT.usage
  }
  if (parsed.kind === 'list-rules') {
    // Evaluates no artifacts, and says so by exiting 0 with only the catalogue.
    for (const line of renderRuleList(RULES)) io.out(line)
    io.out('')
    io.out(
      `${String(configurableRules().length)} of ${String(RULES.length)} have a configurable severity; the rest are bookkeeping about the run.`,
    )
    return EXIT.ok
  }
  if (parsed.kind === 'explain') {
    const rule = ruleById(parsed.ruleId)
    if (rule === undefined) {
      io.err(`prompt-lint: unknown rule '${parsed.ruleId}'.`)
      return EXIT.usage
    }
    for (const line of renderRuleExplanation(rule)) io.out(line)
    return EXIT.ok
  }

  const outcome = runPromptLintGate({ ...parsed.options, repoRoot })
  if (outcome.report === null) {
    io.err('prompt-lint: could not complete the run.')
    for (const failure of outcome.failures) io.err(`  ${failure}`)
    return outcome.exitCode
  }

  for (const line of renderHuman(outcome.report, { maxFindings: parsed.maxFindings })) {
    io.out(line)
  }
  return outcome.exitCode
}

/* c8 ignore start — the process wiring itself; every decision above is covered. */
if (process.argv[1]?.endsWith('cli.ts')) {
  const io: GateIo = {
    out: (message: string) => process.stdout.write(`${message}\n`),
    err: (message: string) => process.stderr.write(`${message}\n`),
  }
  try {
    process.exit(runCli(process.argv.slice(2), io, process.cwd()))
  } catch (error) {
    io.err(error instanceof Error ? error.message : 'prompt-lint failed')
    process.exit(EXIT.internal)
  }
}
/* c8 ignore stop */
