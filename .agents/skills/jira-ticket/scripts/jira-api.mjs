// Jira REST helpers: per-repo config, credentials, and request plumbing.
//
// Deliberately mirrors scripts/jira-sprint.sh so both tools resolve the same way:
// env var > .agents/skills.config > built-in default, with credentials never read
// from the (committed) config file — email from $JIRA_EMAIL, token from the OS
// keychain. See the header of jira-sprint.sh for the one-time token setup.

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

export function jiraSite() {
  const site = setting('JIRA_SITE', 'jira_site')
  if (!site) {
    throw new Error(
      'no Jira site configured. Set it for this repo:\n' +
        "  sh lib/skills.sh config set 'jira_site=your-org.atlassian.net'\n" +
        '…or export JIRA_SITE.',
    )
  }
  return site
}

export function jiraEmail() {
  const email = process.env.JIRA_EMAIL
  if (!email) {
    throw new Error(
      'JIRA_EMAIL is not set. Export it in your shell profile, e.g.:\n  export JIRA_EMAIL="you@company.com"',
    )
  }
  return email
}

/** Fetch the API token from the OS keychain. Never accept it as an argument or from config. */
export function jiraToken(email = jiraEmail()) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['security', ['find-generic-password', '-a', email, '-s', 'jira-api-token', '-w']]
      : ['secret-tool', ['lookup', 'service', 'jira-api-token', 'account', email]]
  let token = ''
  try {
    token = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    token = ''
  }
  if (!token) {
    const store =
      process.platform === 'darwin'
        ? `  read -s "JIRA_TOKEN?Paste Jira API token: "; echo\n` +
          `  security add-generic-password -a "${email}" -s "jira-api-token" -U -w "$JIRA_TOKEN"\n` +
          '  unset JIRA_TOKEN'
        : `  secret-tool store --label="Jira API Token" service jira-api-token account "${email}"`
    throw new Error(
      `no API token found in the keychain for account '${email}'.\nStore one with:\n${store}\n` +
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

/** Resolve an assignee to an accountId. Accepts `@me`, an email, or a display name. */
export async function resolveAccountId(assignee) {
  if (assignee === '@me') return (await api('GET', '/rest/api/3/myself')).accountId
  const found = await api('GET', `/rest/api/3/user/search?query=${encodeURIComponent(assignee)}`)
  if (!Array.isArray(found) || found.length === 0)
    throw new Error(`no Jira user matched '${assignee}'`)
  return found[0].accountId
}
