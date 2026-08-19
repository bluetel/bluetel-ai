#!/usr/bin/env node
/* eslint-disable -- Skill payload, not this repo's source. skills.sh copies this file verbatim
   into target repos and content-hashes the copy against the catalog, so any tool that rewrites
   it there reports the skill as locally-modified on the next update. The directives below say
   the same thing to the other toolchains a target repo might run. */
// oxlint-disable
/** biome-ignore-all lint: skill payload copied verbatim — see the eslint-disable above */
/** biome-ignore-all format: skill payload copied verbatim — see the eslint-disable above */
// oxfmt-ignore
// prettier-ignore
//
// Move one or more Jira issues to a sprint, using the public Jira Agile REST API
// (not acli, which has no sprint-assignment command).
//
// Per-repo values (site, board) come from `.agents/skills.config` — the shared
// skills config — so this script is not tied to any one project. Resolution
// order for each value: environment variable > .agents/skills.config > built-in
// default. Credentials are NEVER read from that file (it is committed): the
// account email comes from $JIRA_EMAIL and the token from the OS keychain.
//
// Setup (one-time, run yourself — never paste the token into a chat/agent):
//   macOS (zsh, the default shell): `security add-generic-password -w` alone truncates
//   long tokens (~128 chars) because its hidden prompt uses the old getpass() buffer —
//   Atlassian API tokens run ~192 chars, so that form silently corrupts them. Use a
//   shell-side hidden read instead, then pass the value through as the -w argument:
//     read -s "JIRA_TOKEN?Paste Jira API token: "; echo
//     security add-generic-password -a "$JIRA_EMAIL" -s "jira-api-token" -U -w "$JIRA_TOKEN"
//     unset JIRA_TOKEN
//   (bash uses `read -s -p "prompt" JIRA_TOKEN` instead — zsh's -p means "read from a
//   coprocess", not "show a prompt", so the bash form fails with "read: -p: no coprocess")
//   Linux:  secret-tool store --label="Jira API Token" service jira-api-token account "$JIRA_EMAIL"
//           (prompts for the token on stdin — no known length limit there)
//
// Create a token at: https://id.atlassian.com/manage-profile/security/api-tokens
//
// Usage:
//   jira-sprint.mjs KEY [KEY ...]              # move to the board's current active sprint
//   jira-sprint.mjs --sprint 42 KEY [KEY ...]  # move to a specific sprint ID
//   jira-sprint.mjs --backlog KEY [KEY ...]    # move back to the backlog (out of any sprint)
//
// Env vars (each overrides the config file):
//   JIRA_EMAIL     (required — no default; set in your shell profile, e.g. export JIRA_EMAIL="you@company.com")
//   JIRA_SITE      (config: jira_site; default: bluetel.atlassian.net)
//   JIRA_BOARD_ID  (config: jira_board_id; no default — required for sprint moves)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { api, setting } from './jira-api.mjs'

/** Print this file's own header comment as the help text. */
function usage() {
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  console.log(
    self
      .split('\n')
      .filter((line) => line.startsWith('//'))
      .map((line) => line.replace(/^\/\/ ?/, ''))
      .join('\n'),
  )
}

/** Parse argv into a sprint target and the issue keys to move. */
export function parseArgs(argv) {
  let sprintId = ''
  let backlog = false
  const issues = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--sprint') {
      sprintId = argv[++i]
      if (!sprintId) throw new Error('--sprint needs a value')
    } else if (arg === '--backlog') {
      backlog = true
    } else if (arg === '-h' || arg === '--help') {
      usage()
      process.exit(0)
    } else {
      issues.push(arg)
    }
  }

  if (issues.length === 0) {
    throw new Error(
      'no issue keys given. Usage: jira-sprint.mjs [--sprint ID|--backlog] KEY [KEY ...]',
    )
  }
  return { sprintId, backlog, issues }
}

/** The board's currently active sprint. A board is only needed for this lookup. */
async function activeSprintId(boardId) {
  if (!boardId) {
    throw new Error(
      'no Jira board configured, so the active sprint cannot be found. Set it once for this repo:\n' +
        "  sh lib/skills.sh config set 'jira_board_id=<id>'   # or edit .agents/skills.config\n" +
        '…or pass a sprint explicitly with --sprint <id>, or export JIRA_BOARD_ID.',
    )
  }
  const found = await api('GET', `/rest/agile/1.0/board/${boardId}/sprint?state=active`)
  const sprint = found.values?.[0]
  if (!sprint) throw new Error(`no active sprint found on board ${boardId}.`)
  return sprint.id
}

async function main() {
  const { sprintId, backlog, issues } = parseArgs(process.argv.slice(2))

  if (backlog) {
    await api('POST', '/rest/agile/1.0/backlog/issue', { issues })
    console.log(`Moved ${issues.join(' ')} to the backlog.`)
    return
  }

  const targetSprint =
    sprintId || String(await activeSprintId(setting('JIRA_BOARD_ID', 'jira_board_id')))
  await api('POST', `/rest/agile/1.0/sprint/${targetSprint}/issue`, { issues })
  console.log(`Moved ${issues.join(' ')} to sprint ${targetSprint}.`)
}

// Only run when invoked as a script. Importing the module must not execute the CLI,
// so the argument-handling above can be unit tested.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`)
    process.exit(1)
  })
}
