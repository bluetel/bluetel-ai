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
// Create or re-describe a Jira issue with a properly formatted description.
//
// Use this instead of `acli jira workitem create`. acli sends --description as
// plain text, so markdown arrives in Jira as literal `**bold**` / `## heading`
// characters. This converts the markdown to ADF (Atlassian Document Format) and
// POSTs that to the REST API, so headings, lists, links and code render.
//
// Config (site, project, epic) comes from `.agents/skills.config`; credentials come
// from $JIRA_EMAIL plus the OS keychain. See the header of jira-sprint.mjs for setup.
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
//   # set project-specific custom fields (ids differ per project — check Jira)
//   jira-issue.mjs create --type Bug --summary "…" \
//     --field customfield_12042="Client" --field customfield_11718=2 < body.md
//
// Flags take their value as a separate argument: `--summary "x"`, never
// `--summary=x`. Unknown flags are rejected rather than ignored, so a typo cannot
// silently drop --dry-run and create a real ticket.
//
// Options:
//   --type <Story|Task|Bug>  issue type                     (create, required)
//   --summary <text>        short title, max ~80 chars      (create, required)
//   --key <KEY>             issue to update                 (update, required)
//   --description-file <f>  read markdown from a file       (default: stdin)
//   --project <KEY>         defaults to config jira_project_key / ticket_prefix
//   --parent <KEY>          epic; defaults to config jira_epic_key
//   --assignee <who>        @me, an email, or an exact display name
//   --label <a,b>           comma-separated labels (replaces the existing set)
//   --field <id>=<value>    set any other field; repeatable. JSON-looking values
//                           are sent as JSON, everything else as a string
//   --sprint                move into the board's active sprint after creating
//   --no-sprint             leave it in the backlog
//                           (default comes from config jira_create_into)
//   --dry-run               print the request payload and exit, making no API call
//   --json                  print the raw API response

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { markdownToAdfDocument } from './adf.mjs'
import { api, configValue, resolveAccountId, setting } from './jira-api.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const ISSUE_TYPES = ['Story', 'Task', 'Bug']

/** Flags that take a following argument as their value. */
const VALUED_FLAGS = new Set([
  'type',
  'summary',
  'key',
  'description-file',
  'project',
  'parent',
  'assignee',
  'label',
  'field',
])

/** Flags that are on/off. Anything outside these two sets is a mistake, not a no-op. */
const BOOLEAN_FLAGS = new Set(['sprint', 'no-sprint', 'dry-run', 'json'])

/**
 * Fields this script derives itself. Letting --field set them would defeat the point:
 * `--field description=...` would replace the converted ADF with a raw string, which
 * is the exact bug this script exists to fix.
 */
const RESERVED_FIELDS = new Set([
  'description',
  'summary',
  'project',
  'issuetype',
  'parent',
  'labels',
  'assignee',
])

/**
 * Reject `--flag=value`. It is the dominant convention elsewhere, so without this it
 * registers as an unrecognised flag name — and `--dry-run=true` silently leaves
 * dry-run unset, turning a rehearsal into a real ticket.
 */
function rejectEqualsForm(name) {
  if (!name.includes('=')) return
  const [head] = name.split('=')
  throw new Error(
    BOOLEAN_FLAGS.has(head)
      ? `--${head} is a switch and takes no value — pass it on its own`
      : `use \`--${head} <value>\`, not \`--${head}=<value>\``,
  )
}

/** The value following a valued flag. Absent, or another flag, means it was omitted. */
function valueFor(name, next) {
  if (next === undefined || next.startsWith('--')) throw new Error(`--${name} needs a value`)
  return next
}

function unknownFlag(name) {
  const valid = [...VALUED_FLAGS, ...BOOLEAN_FLAGS]
    .map((flag) => `--${flag}`)
    .sort()
    .join(', ')
  return new Error(`unknown flag --${name}. Valid flags: ${valid}`)
}

export function parseArgs(argv) {
  const flags = { _: [], field: [] }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      flags._.push(arg)
      continue
    }

    const name = arg.slice(2)
    rejectEqualsForm(name)

    if (VALUED_FLAGS.has(name)) {
      const value = valueFor(name, argv[++i])
      if (name === 'field') flags.field.push(value)
      else flags[name] = value
    } else if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true
    } else {
      throw unknownFlag(name)
    }
  }

  // Nothing here takes a positional argument. A stray one is almost always a switch
  // being given a value — `--sprint 42`, which the sibling jira-sprint.mjs does accept
  // — and silently dropping it would send the ticket somewhere unasked.
  if (flags._.length > 0) {
    throw new Error(
      `unexpected argument '${flags._[0]}'. This command takes no positional arguments;` +
        ' to target a specific sprint, create the issue then run' +
        ' jira-sprint.mjs --sprint <id> <KEY>.',
    )
  }
  return flags
}

/**
 * Should `raw` be sent as JSON rather than a string? Only for values that clearly
 * are JSON: `2` becomes a number, but `1.10` stays the string it was written as
 * rather than silently becoming 1.1.
 */
function shouldParseAsJson(raw) {
  if (/^[{[]/.test(raw)) return true
  if (raw === 'true' || raw === 'false' || raw === 'null') return true
  try {
    return String(JSON.parse(raw)) === raw
  } catch {
    return false
  }
}

/** Turn repeated `--field id=value` into a fields object. */
export function parseExtraFields(entries) {
  const fields = {}
  for (const entry of entries) {
    const split = entry.indexOf('=')
    if (split < 1) throw new Error(`--field expects <id>=<value>, got '${entry}'`)
    const id = entry.slice(0, split).trim()
    const raw = entry.slice(split + 1)
    if (RESERVED_FIELDS.has(id)) {
      throw new Error(
        `--field cannot set '${id}' — this script derives it. ` +
          (id === 'description'
            ? 'Pass the description on stdin or with --description-file.'
            : `Use --${id} instead where one exists.`),
      )
    }
    fields[id] = shouldParseAsJson(raw) ? JSON.parse(raw) : raw
  }
  return fields
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
 *
 * stdin is drained asynchronously rather than with a sync read of fd 0: the
 * documented invocation pipes from a producer that may not have written anything
 * yet, and a sync read of a not-yet-ready pipe fails with EAGAIN.
 */
export async function readDescription(flags, stdin = process.stdin) {
  if (flags['description-file']) return readFileSync(flags['description-file'], 'utf8')
  if (stdin.isTTY) return null
  let body = ''
  stdin.setEncoding('utf8')
  for await (const chunk of stdin) body += chunk
  return body.trim() === '' ? null : body
}

/** Resolve the project key, rejecting the "this repo has no Jira" placeholder. */
export function resolveProject(flags) {
  // ticket_prefix is the fallback, but some repos park a placeholder like
  // "{no jira board}" in it to mean "this project does not use Jira".
  const project =
    flags.project || setting('JIRA_PROJECT_KEY', 'jira_project_key') || configValue('ticket_prefix')
  if (!project || project.startsWith('{')) {
    throw new Error(
      'no Jira project key configured. Set it for this repo:\n' +
        "  sh lib/skills.sh config set 'jira_project_key=ABC'\n" +
        '…or pass --project.',
    )
  }
  return project
}

/** Normalise `--type` to the canonical name Jira expects. */
export function resolveIssueType(given) {
  if (!given) throw new Error(`--type is required (${ISSUE_TYPES.join(', ')})`)
  const type = ISSUE_TYPES.find((t) => t.toLowerCase() === given.toLowerCase())
  if (!type) {
    throw new Error(
      `unknown --type '${given}'. Expected one of: ${ISSUE_TYPES.join(', ')}.\n` +
        'If this project genuinely uses another type, confirm with the user, then set it with' +
        ` --field issuetype='{"name":"${given}"}'.`,
    )
  }
  return type
}

/** The fields that only apply when creating: project, type, summary, epic. */
function creationFields(flags) {
  const project = resolveProject(flags)
  const issuetype = resolveIssueType(flags.type)
  if (!flags.summary) throw new Error('--summary is required')

  const fields = {
    project: { key: project },
    issuetype: { name: issuetype },
    summary: flags.summary,
  }
  const parent = flags.parent || setting('JIRA_EPIC_KEY', 'jira_epic_key')
  if (parent) fields.parent = { key: parent }
  return fields
}

/** Flags that are a meaningful edit on their own, so a description is not required. */
function hasOtherEdits(flags) {
  return (
    Boolean(flags.summary || flags.label || flags.assignee || flags.parent) ||
    flags.field.length > 0
  )
}

/**
 * Convert the description to ADF, or return null when none was given. On update,
 * changing only the summary, labels, assignee, parent or a custom field is legitimate.
 */
async function descriptionField(flags, { forCreate }) {
  const description = await readDescription(flags)
  if (description !== null) return markdownToAdfDocument(description)

  if (forCreate || !hasOtherEdits(flags)) {
    throw new Error('no description given — pipe markdown on stdin, or pass --description-file')
  }
  return null
}

export async function buildFields(flags, { forCreate }) {
  const fields = forCreate ? creationFields(flags) : {}

  if (!forCreate) {
    if (flags.summary) fields.summary = flags.summary
    if (flags.parent) fields.parent = { key: flags.parent }
    if (flags.type) throw new Error('--type cannot be changed on update; do it in the Jira UI')
    if (flags.project) throw new Error('--project only applies to create')
  }

  const description = await descriptionField(flags, { forCreate })
  if (description) fields.description = description

  if (flags.label) {
    fields.labels = flags.label
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean)
  }
  // Resolving an assignee is a live API call, so skip it under --dry-run, which
  // documents itself as making no request.
  if (flags.assignee) {
    fields.assignee = flags['dry-run']
      ? { accountId: `<resolved from '${flags.assignee}' at run time>` }
      : { accountId: await resolveAccountId(flags.assignee) }
  }

  Object.assign(fields, parseExtraFields(flags.field))

  return fields
}

/**
 * Should the new issue go into the active sprint? Explicit flags win, then the
 * `jira_create_into` config key. The documented default is the backlog: new
 * tickets sit there until the team refines them.
 */
export function wantsSprint(flags) {
  if (flags.sprint && flags['no-sprint']) {
    throw new Error('--sprint and --no-sprint are mutually exclusive')
  }
  if (flags.sprint) return true
  if (flags['no-sprint']) return false

  const configured = setting('JIRA_CREATE_INTO', 'jira_create_into', 'backlog').toLowerCase()
  if (configured !== 'backlog' && configured !== 'sprint') {
    throw new Error(`jira_create_into must be 'backlog' or 'sprint', got '${configured}'`)
  }
  return configured === 'sprint'
}

async function create(flags) {
  const fields = await buildFields(flags, { forCreate: true })
  const goesToSprint = wantsSprint(flags) // validated before anything is created

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

  if (goesToSprint) {
    const sprintScript = join(HERE, 'jira-sprint.mjs')
    try {
      execFileSync(sprintScript, [created.key], { stdio: 'inherit' })
    } catch (cause) {
      // The issue exists but is not where it was asked to go. Say which half failed
      // and fail loudly — a caller that sees exit 0 will treat this as done.
      throw new Error(
        `created ${created.key}, but the move into the active sprint failed.\n` +
          `Retry just that step with: '${sprintScript}' ${created.key}`,
        { cause },
      )
    }
  } else {
    console.log('Left in the backlog. Notify the team so it can be refined and put on the board.')
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

// Only run when invoked as a script. Importing the module must not execute the CLI,
// so the argument-handling above can be unit tested.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`)
    if (error.cause) console.error(String(error.cause.message ?? error.cause))
    process.exit(1)
  })
}
