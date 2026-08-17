#!/usr/bin/env node
//
// Create or re-describe a Jira issue with a properly formatted description.
//
// Use this instead of `acli jira workitem create`. acli sends --description as
// plain text, so markdown arrives in Jira as literal `**bold**` / `## heading`
// characters. This converts the markdown to ADF (Atlassian Document Format) and
// POSTs that to the REST API, so headings, lists, links and code render.
//
// Config (site, project, epic) comes from `.agents/skills.config`; credentials come
// from $JIRA_EMAIL plus the OS keychain. See the header of jira-sprint.sh for setup.
//
// Usage:
//   # description on stdin — preferred, no shell quoting to get wrong
//   jira-issue.mjs create --type Bug --summary "Play bar does not reset" < body.md
//   jira-issue.mjs create --type Task --summary "Add has_author_page field" --description-file body.md
//
//   # fix a ticket that already has literal markdown in it
//   jira-issue.mjs update --key NA-1234 < body.md
//
//   # see the ADF without touching Jira
//   jira-issue.mjs create --type Bug --summary "…" --dry-run < body.md
//
// Options:
//   --type <Bug|Task>       issue type                     (create, required)
//   --summary <text>        short title, max ~80 chars      (create, required)
//   --key <KEY>             issue to update                 (update, required)
//   --description-file <f>  read markdown from a file       (default: stdin)
//   --project <KEY>         defaults to config jira_project_key / ticket_prefix
//   --parent <KEY>          epic; defaults to config jira_epic_key
//   --assignee <who>        @me, an email, or a display name
//   --label <a,b>           comma-separated labels
//   --no-sprint             skip the move into the active sprint (create only)
//   --dry-run               print the request payload and exit
//   --json                  print the raw API response

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { markdownToAdfDocument } from './adf.mjs'
import { api, configValue, resolveAccountId, setting } from './jira-api.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const flags = { _: [] }
  const valued = new Set([
    'type',
    'summary',
    'key',
    'description-file',
    'description',
    'project',
    'parent',
    'assignee',
    'label',
  ])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      flags._.push(arg)
      continue
    }
    const name = arg.slice(2)
    if (valued.has(name)) {
      const value = argv[++i]
      if (value === undefined) throw new Error(`--${name} needs a value`)
      flags[name] = value
    } else {
      flags[name] = true
    }
  }
  return flags
}

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

/**
 * Read the markdown description, or return null when none was supplied.
 * Reading fd 0 would block on an interactive terminal, so only consume stdin
 * when it is actually a pipe or file.
 */
function readDescription(flags) {
  if (flags['description-file']) return readFileSync(flags['description-file'], 'utf8')
  if (flags.description) return flags.description
  if (process.stdin.isTTY) return null
  const stdin = readFileSync(0, 'utf8')
  return stdin.trim() === '' ? null : stdin
}

async function buildFields(flags, { forCreate }) {
  const fields = {}

  if (forCreate) {
    // ticket_prefix is the fallback, but some repos park a placeholder like
    // "{no jira board}" in it to mean "this project does not use Jira".
    const project =
      flags.project ||
      setting('JIRA_PROJECT_KEY', 'jira_project_key') ||
      configValue('ticket_prefix')
    if (!project || project.startsWith('{')) {
      throw new Error(
        'no Jira project key configured. Set it for this repo:\n' +
          "  sh lib/skills.sh config set 'jira_project_key=ABC'\n" +
          '…or pass --project.',
      )
    }
    if (!flags.type) throw new Error('--type is required (Bug or Task)')
    if (!flags.summary) throw new Error('--summary is required')
    fields.project = { key: project }
    fields.issuetype = { name: flags.type }
    fields.summary = flags.summary

    const parent = flags.parent || setting('JIRA_EPIC_KEY', 'jira_epic_key')
    if (parent) fields.parent = { key: parent }
  } else if (flags.summary) {
    fields.summary = flags.summary
  }

  const description = readDescription(flags)
  if (description === null) {
    // On update, changing only the summary or labels is legitimate.
    if (forCreate || !(flags.summary || flags.label || flags.assignee)) {
      throw new Error('no description given — pipe markdown on stdin, or pass --description-file')
    }
  } else {
    fields.description = await markdownToAdfDocument(description)
  }

  if (flags.label)
    fields.labels = flags.label
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean)
  if (flags.assignee) fields.assignee = { accountId: await resolveAccountId(flags.assignee) }

  return fields
}

async function create(flags) {
  const fields = await buildFields(flags, { forCreate: true })

  if (flags['dry-run']) {
    console.log(JSON.stringify({ fields }, null, 2))
    return
  }

  const created = await api('POST', '/rest/api/3/issue', { fields })
  const site = setting('JIRA_SITE', 'jira_site')
  console.log(`Created ${created.key} — https://${site}/browse/${created.key}`)

  if (!fields.parent) {
    console.log('No epic configured (jira_epic_key is unset), so the issue is unparented.')
  }

  if (!flags['no-sprint']) {
    const sprintScript = join(HERE, 'jira-sprint.sh')
    try {
      execFileSync(sprintScript, [created.key], { stdio: 'inherit' })
    } catch {
      console.error(
        `Created ${created.key}, but the sprint move failed — run: ${sprintScript} ${created.key}`,
      )
    }
  }

  if (flags.json) console.log(JSON.stringify(created, null, 2))
}

async function update(flags) {
  if (!flags.key) throw new Error('--key is required for update')
  const fields = await buildFields(flags, { forCreate: false })

  if (flags['dry-run']) {
    console.log(JSON.stringify({ fields }, null, 2))
    return
  }

  await api('PUT', `/rest/api/3/issue/${encodeURIComponent(flags.key)}`, { fields })
  const site = setting('JIRA_SITE', 'jira_site')
  console.log(`Updated ${flags.key} — https://${site}/browse/${flags.key}`)
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    usage()
    process.exit(command ? 0 : 1)
  }
  const flags = parseArgs(rest)
  if (command === 'create') await create(flags)
  else if (command === 'update') await update(flags)
  else throw new Error(`unknown command '${command}' (expected: create, update)`)
}

main().catch((error) => {
  console.error(`Error: ${error.message}`)
  if (error.cause) console.error(String(error.cause.message ?? error.cause))
  process.exit(1)
})
