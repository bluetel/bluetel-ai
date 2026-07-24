#!/usr/bin/env tsx
import process from 'node:process'

import { runQltyDiffGate, type GateIo } from '.'

// Usage:
//   tsx src/cli.ts [baseRef]   # diff vs base (default: origin/main)
//   tsx src/cli.ts --all       # scan the whole codebase instead
//   pnpm qlty:diff
//   pnpm qlty:diff origin/staging
//   pnpm qlty:diff --all
const io: GateIo = {
  out: (message: string) => process.stdout.write(`${message}\n`),
  err: (message: string) => process.stderr.write(`${message}\n`),
}

try {
  process.exit(runQltyDiffGate(process.argv.slice(2), io))
} catch (error) {
  io.err(error instanceof Error ? error.message : 'qlty diff gate failed')
  process.exit(2)
}
