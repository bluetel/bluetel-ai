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
// Jira REST helpers: per-repo config, credentials, and request plumbing.
//
// Deliberately mirrors scripts/jira-sprint.mjs so both tools resolve the same way:
// env var > .agents/skills.config > built-in default, with credentials never read
// from the (committed) config file — email from $JIRA_EMAIL, token from the OS
// keychain. See the header of jira-sprint.mjs for the one-time token setup.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'

/** Read a key from the nearest `.agents/skills.config`, walking up from `startDir`. */
export function configValue(key, startDir = process.cwd()) {
  let dir = startDir
  const { root } = parse(dir)
  while (true) {
    const file = join(dir, '.agents', 'skills.config')
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim()
      }
      return ''
    }
    if (dir === root) return ''
    const parent = dirname(dir)
    if (parent === dir) return ''
    dir = parent
  }
}

/** Resolve a setting: environment variable, then config file, then fallback. */
export function setting(envVar, configKey, fallback = '') {
  return process.env[envVar] || configValue(configKey) || fallback
}

/** A bare hostname — no scheme, port, path, userinfo or whitespace. */
const HOSTNAME = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i

export function jiraSite() {
  const site = setting('JIRA_SITE', 'jira_site')
  if (!site) {
    throw new Error(
      'no Jira site configured. Set it for this repo:\n' +
        "  sh lib/skills.sh config set 'jira_site=your-org.atlassian.net'\n" +
        '…or export JIRA_SITE.',
    )
  }
  // This value is concatenated into a URL that carries the API token in an
  // Authorization header, so a value containing '/' or '@' would redirect those
  // credentials to another host. It must be a hostname and nothing else.
  if (!HOSTNAME.test(site)) {
    throw new Error(
      `jira_site must be a bare hostname like 'your-org.atlassian.net', got '${site}'.\n` +
        'Remove any scheme, port, path or trailing slash.',
    )
  }
  return site
}

export function jiraEmail() {
  const email = process.env.JIRA_EMAIL
  if (!email) {
    throw new Error(
      'JIRA_EMAIL is not set. Export it in your shell profile, e.g.:\n' +
        '  export JIRA_EMAIL="you@company.com"\n' +
        'If it is unset, check `acli --version` too: an unset email usually means this machine\n' +
        'has had no Jira setup at all, and the transition and assignment steps need acli.',
    )
  }
  return email
}

/** Fetch the API token from the OS keychain. Never accept it as an argument or from config. */
export function jiraToken(email = jiraEmail()) {
  if (process.platform === 'win32') {
    throw new Error(
      'no keychain integration for Windows — this script reads the token from the macOS keychain' +
        ' (security) or a libsecret keyring (secret-tool). Run it from WSL, or export the token' +
        ' into JIRA_API_TOKEN_CMD support by extending jiraToken() in jira-api.mjs.',
    )
  }
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['security', ['find-generic-password', '-a', email, '-s', 'jira-api-token', '-w']]
      : ['secret-tool', ['lookup', 'service', 'jira-api-token', 'account', email]]
  let token = ''
  let failure = ''
  try {
    token = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    // Distinguish "no such tool" from "no such entry" from "keychain locked" — all
    // three arrive here, and telling someone to store a token they already have
    // invites them to overwrite it with -U.
    const stderr = String(error.stderr ?? '').trim()
    failure =
      error.code === 'ENOENT'
        ? `\`${cmd}\` is not installed or not on PATH.`
        : stderr || `\`${cmd}\` exited with status ${error.status ?? 'unknown'}.`
    token = ''
  }
  if (!token) {
    // Both shell forms, because the zsh-only `read -s "VAR?prompt"` fails in bash —
    // jira-sprint.sh documents the same pair.
    const store =
      process.platform === 'darwin'
        ? '  # zsh (the macOS default):\n' +
          '  read -s "JIRA_TOKEN?Paste Jira API token: "; echo\n' +
          '  # bash:\n' +
          '  read -s -p "Paste Jira API token: " JIRA_TOKEN; echo\n' +
          `  security add-generic-password -a "${email}" -s "jira-api-token" -U -w "$JIRA_TOKEN"\n` +
          '  unset JIRA_TOKEN'
        : `  secret-tool store --label="Jira API Token" service jira-api-token account "${email}"`
    throw new Error(
      `could not read the Jira API token for account '${email}'.\n` +
        `${failure ? `${failure}\n` : 'The keychain returned nothing for that account.\n'}` +
        'If a token is already stored, this may instead be a locked or declined keychain prompt —' +
        ' check before re-storing, since -U overwrites the existing entry.\n' +
        `Otherwise store one with:\n${store}\n` +
        'Create a token at https://id.atlassian.com/manage-profile/security/api-tokens',
    )
  }
  return token
}

/** Perform an authenticated Jira REST call, throwing a readable error on failure. */
export async function api(method, path, body) {
  const email = jiraEmail()
  const auth = Buffer.from(`${email}:${jiraToken(email)}`).toString('base64')
  const response = await fetch(`https://${jiraSite()}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok) {
    let detail = text
    try {
      const parsed = JSON.parse(text)
      const messages = [
        ...(parsed.errorMessages ?? []),
        ...Object.entries(parsed.errors ?? {}).map(([k, v]) => `${k}: ${v}`),
      ]
      if (messages.length) detail = messages.join('; ')
    } catch {
      // non-JSON body — surface it as-is
    }
    throw new Error(`${method} ${path} failed (${response.status}): ${detail}`)
  }
  return text ? JSON.parse(text) : null
}

/**
 * Resolve an assignee to an accountId. Accepts `@me`, an email, or an exact display name.
 *
 * `/user/search` is a fuzzy, relevance-ranked match, so taking the first hit would
 * happily assign "John" to "Johnny Doe" or a deactivated account. An ambiguous query
 * is reported with its candidates instead — a ticket on the wrong person's board only
 * surfaces when the work does not get picked up.
 */
export async function resolveAccountId(assignee) {
  if (assignee === '@me') return (await api('GET', '/rest/api/3/myself')).accountId

  const found = await api('GET', `/rest/api/3/user/search?query=${encodeURIComponent(assignee)}`)
  if (!Array.isArray(found) || found.length === 0) {
    throw new Error(`no Jira user matched '${assignee}'`)
  }

  const active = found.filter((user) => user.active !== false)
  if (active.length === 0) {
    throw new Error(`every Jira user matching '${assignee}' is deactivated`)
  }

  const wanted = assignee.toLowerCase()
  const exact = active.filter(
    (user) =>
      user.emailAddress?.toLowerCase() === wanted || user.displayName?.toLowerCase() === wanted,
  )
  if (exact.length === 1) return exact[0].accountId
  if (active.length === 1) return active[0].accountId

  const candidates = active
    .slice(0, 10)
    .map((user) => `  ${user.displayName}${user.emailAddress ? ` <${user.emailAddress}>` : ''}`)
    .join('\n')
  throw new Error(
    `'${assignee}' matches ${active.length} Jira users. Pass an exact email or display name:\n${candidates}`,
  )
}
