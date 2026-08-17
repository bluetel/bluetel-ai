/**
 * `conventions/config-mismatch` — the live defect that is the strongest argument for the
 * whole feature. `.agents/remote-workflow-instructions.md` tells the agent, under a
 * heading that says "Never invent them", that the ticket prefix is `URM` and the
 * repository is `harrytwigg/universal-react-monorepo`; `.agents/skills.config` — the file
 * the skills actually read — says `bluetel/bluetel-ai` and records no ticket board.
 *
 * The rule is bounded to **mechanical comparisons against a configured value**. It never
 * reads the meaning of a sentence. That bound is not modesty, it is the whole design:
 * every one of the three things it compares is shaped like ordinary text, so a pattern
 * that fires without an anchor fires everywhere.
 *
 *  - **`owner/repo` is shaped exactly like a relative path.** `references/notes.md`,
 *    `tooling/skills`, `catalog/review` — a bare two-segment pattern reports every path in
 *    every document. Four conditions therefore have to hold: the token is inside a code
 *    span (or is a `github.com/…` URL, which carries its own context), the text
 *    immediately before it names it as a repository (`repo`, `remote`, `origin`, `--repo`,
 *    `gh -R`), it has exactly two segments, and neither segment is a git ref word or a
 *    real directory in this tree.
 *  - **A branch name is an English word.** `main` and `staging` appear in prose
 *    constantly. A branch name is only read as a claim about *this repository's* base or
 *    staging branch when it sits in a code span next to a phrase that assigns it that
 *    role — `base branch`, `default branch`, `staging branch`, `PRs target …`,
 *    `against …`.
 *  - **`PREFIX-123` is the shape of half the acronyms in technical prose** — `UTF-8`,
 *    `SHA-256`, `RFC-2119`, and this repository's own `FR-007` / `SC-004` requirement
 *    ids. So the line must also carry a ticket-convention word, and a short list of
 *    standards and requirement-id prefixes is excluded outright.
 *
 * The self-match hazard that bit `refs/dangling-path` applies here too, and is why every
 * anchor test reads `line.slice(0, column)` rather than the whole line: the token
 * `repo/settings` contains the word `repo`, and a whole-line anchor test would let a
 * candidate vouch for itself.
 *
 * With no `.agents/skills.config`, or with the compared key absent from it, the rule is
 * **silent** rather than not-evaluated. `needs` describes parsed views of the artifact,
 * so it cannot express "the repository has no config"; and more to the point, a
 * convention nobody configured is a convention no artifact can contradict. There is
 * nothing to compare against, not a comparison that failed to run.
 */
// The wrong owner in the live defect is a GitHub username, not a word. Ignored here rather
// than added to the shared dictionary, which is for words the codebase actually uses.
// cspell:ignore harrytwigg
import { inRanges, metaGet } from '../artifact'
import type { MarkdownView, MetaBlock, PathToken } from '../artifact'
import type { ArtifactKind, PathIndex } from '../scope'

import { defineRule, requireArtifact, type FindingDraft } from './define'

const CONFIG = '.agents/skills.config'

const APPLIES_TO: ArtifactKind[] = ['catalog-skill', 'installed-skill', 'guidance']

/** The configured values this rule compares against. Null means "not configured". */
interface Conventions {
  /** `owner/repo`, assembled from `repo_owner` and `repo_name`. */
  slug: string | null
  /** The `ticket_prefix` value verbatim — which in this repo is a "there is none" note. */
  ticketPrefix: string | null
  baseBranch: string | null
  stagingBranch: string | null
}

/** A configured value, or null when the key is absent or blank. Blank is not a convention. */
const configured = (config: MetaBlock, key: string): string | null => {
  const value = metaGet(config, key)
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

const readConventions = (config: MetaBlock): Conventions => {
  const owner = configured(config, 'repo_owner')
  const name = configured(config, 'repo_name')
  return {
    slug: owner === null || name === null ? null : `${owner}/${name}`,
    ticketPrefix: configured(config, 'ticket_prefix'),
    baseBranch: configured(config, 'base_branch'),
    stagingBranch: configured(config, 'staging_branch'),
  }
}

/** Trailing punctuation that sits between an anchor word and the value it introduces. */
const ANCHOR_NOISE = /[`'"([<:=\s]+$/

/**
 * The text before a token on its line, with the quoting and punctuation stripped, so an
 * anchor test can ask what word immediately precedes the value.
 */
const precedingWords = (line: string, column: number): string =>
  line.slice(0, column).replace(ANCHOR_NOISE, '')

/**
 * A `lower_snake_case` identifier in backticks — the shape of a `.agents/skills.config` key.
 * Matched by shape rather than against the parsed config's own keys because the config
 * lists only explicitly-set keys: `jira_epic_key` is a catalog default that appears in no
 * config file and in three documents that illustrate it.
 */
const CONFIG_KEY_MENTION = /`[a-z][a-z0-9]*(?:_[a-z0-9]+)+`/
const CONFIG_REFERENCE = /\bskills\.config\b/i
const ILLUSTRATION = /\b(?:for example|for instance|such as)\b|e\.g\./i

/**
 * Is this line documenting the convention rather than asserting one?
 *
 * Measured, not guessed: the first run over the real tree produced nine findings, and six
 * of them were this — `| \`jira_epic_key\` | parent epic … | \`ACME-100\` |` in a table of
 * config keys, and "the `ticket_prefix` plus the number the user gives, `BTAI-1234`". A
 * line that names the config key, names the config file, or flags itself as an example is
 * pointing at `.agents/skills.config`, which is what the remediation asks for. It cannot
 * simultaneously be a second source of truth.
 *
 * Lexical, not semantic, and it costs a real defect written as "set `ticket_prefix` to
 * `URM`". Against six false positives and none of that shape in the tree, that is the
 * trade `refs/dangling-path` already made for the same reason.
 */
const defersToConfig = (line: string): boolean =>
  CONFIG_KEY_MENTION.test(line) || CONFIG_REFERENCE.test(line) || ILLUSTRATION.test(line)

/**
 * The document's lines reduced to the text that is making a claim: fenced blocks and
 * config-deferring lines emptied, HTML-comment spans blanked to spaces with columns
 * preserved so a finding still points at the real column.
 *
 * Content inside a fence or a comment is not a claim the prose is making — it is a
 * transcript of a command, or an author's note — and `refs/dangling-path` draws the same
 * line. Blanking rather than dropping is what keeps the surviving text's columns honest.
 */
const claimLines = (view: MarkdownView): string[] =>
  view.lines.map((line, index) => {
    if (inRanges(view.fenced, index)) return ''
    let masked = line
    for (const span of view.htmlCommentSpans.get(index) ?? []) {
      const end = Math.min(span.end, line.length - 1)
      if (end < span.start) continue
      masked = `${masked.slice(0, span.start)}${' '.repeat(end - span.start + 1)}${masked.slice(end + 1)}`
    }
    return defersToConfig(masked) ? '' : masked
  })

// --- owner/repo ------------------------------------------------------------------------

const REPO_HOSTS = new Set(['github.com', 'www.github.com'])

/**
 * A word that, sitting immediately before a two-segment token, names the token as a
 * repository rather than as a path. `-R` and `--repo` are the `gh` CLI's own flags. The
 * trailing copula is allowed because "the repo is `owner/name`" is the other half of how
 * these documents phrase it, and stripping punctuation alone leaves `is` in the way.
 */
const REPOSITORY_ANCHOR =
  /(?:github\.com|\b(?:repo|repos|repository|repositories|remote|origin|upstream|fork)|--repo|-R)(?:\s+(?:is|are|was|were|should be|must be|will be))?$/i

/** Both halves of a GitHub slug are restricted to the characters GitHub itself allows. */
const SLUG_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Owner segments that mean this is a git ref, not a GitHub slug. `origin/main` and
 * `refs/heads` are two-segment and can sit next to the word `remote`, which is exactly
 * the anchor the slug check looks for.
 */
const GIT_REF_OWNERS = new Set(['origin', 'upstream', 'refs', 'heads', 'remotes', 'HEAD'])

const GIT_SUFFIX = /\.git$/

interface SlugCandidate {
  owner: string
  repo: string
  /** True when the token carried its own `github.com/…` context. */
  hosted: boolean
}

/** Read a slug out of a path-shaped token, or decide the token is not slug-shaped. */
const slugFromToken = (raw: string): SlugCandidate | null => {
  const segments = raw.split('/')
  const hosted = REPO_HOSTS.has(segments[0].toLowerCase())
  if (hosted ? segments.length < 3 : segments.length !== 2) return null
  const owner = hosted ? segments[1] : segments[0]
  const repo = (hosted ? segments[2] : segments[1]).replace(GIT_SUFFIX, '')
  if (!SLUG_SEGMENT.test(owner) || !SLUG_SEGMENT.test(repo)) return null
  if (GIT_REF_OWNERS.has(owner)) return null
  return { owner, repo, hosted }
}

/**
 * Is this token a claim about which repository this is? Path tokens are used rather than a
 * line regex because `PathToken.literal` already rejects `{owner}/{repo}` and every other
 * template shape, and `inCodeSpan` is the tightener that separates a slug quoted as a
 * convention from the bare words `repo owner/name` in a sentence about conventions — a
 * real line of the live defect file, two lines above the real defect.
 */
const isSlugCandidate = (token: PathToken): boolean =>
  token.literal && !token.inFence && !token.inHtmlComment && token.inCodeSpan

const checkSlug = (
  view: MarkdownView,
  masked: readonly string[],
  index: PathIndex,
  slug: string,
): FindingDraft[] => {
  const findings: FindingDraft[] = []
  const reported = new Set<string>()

  for (const token of view.pathTokens) {
    if (!isSlugCandidate(token)) continue
    const line = masked[token.line]
    // Emptied by `claimLines`: a fence, a comment, or a line that defers to the config.
    // Tested explicitly because a `github.com/…` token skips the anchor check below.
    if (line.length === 0) continue
    const candidate = slugFromToken(token.raw)
    if (candidate === null) continue
    if (!candidate.hosted && !REPOSITORY_ANCHOR.test(precedingWords(line, token.column))) continue
    // A first segment that is a real directory here, or a token that is a tracked path,
    // is a path someone wrote next to the word "repo". It is not a repository slug.
    if (index.isDirectory(candidate.owner) || index.has(token.raw)) continue

    const named = `${candidate.owner}/${candidate.repo}`
    if (named.toLowerCase() === slug.toLowerCase()) continue
    if (reported.has(named)) continue
    reported.add(named)

    findings.push({
      line: token.line + 1,
      column: token.column,
      message: `Names the repository \`${named}\`, but \`${CONFIG}\` says \`${slug}\` (\`repo_owner\`/\`repo_name\`).`,
      remediation: `Delete the hardcoded slug and point at \`${CONFIG}\`, or correct it to \`${slug}\`. Prefer deletion: two sources of truth is the defect, and correcting one of them leaves the other in place.`,
    })
  }

  return findings
}

// --- ticket prefix ---------------------------------------------------------------------

/** A ticket prefix as a Jira-style project key: leading letter, then letters or digits. */
const TICKET_PREFIX_SHAPE = /^[A-Z][A-Z0-9]{1,9}$/

/**
 * Prefixes that are never ticket keys, listed because they are all `PREFIX-<digits>`
 * shaped and all appear in exactly the kind of technical prose this rule reads: character
 * encodings and cipher suites, standards references, and the requirement ids this
 * repository's own specifications are written in.
 *
 * The cost of the list is a project whose real ticket prefix happens to be one of these,
 * which would go unreported. The cost of not having it is `UTF-8` and `SC-004` firing.
 */
const NOT_TICKET_PREFIXES = new Set([
  'AES',
  'API',
  'ASCII',
  'CVE',
  'FR',
  'GPT',
  'HTTP',
  'HTTPS',
  'IEEE',
  'ISO',
  'JSON',
  'NFR',
  'RFC',
  'RSA',
  'SC',
  'SHA',
  'SSL',
  'TLS',
  'URI',
  'URL',
  'US',
  'UTC',
  'UTF',
  'YAML',
])

/**
 * The tight form: a phrase that names the convention, then the value. "ticket prefix
 * `URM`" — line 52 of the live defect. The anchor is the phrase itself, so no code span
 * is required.
 *
 * Case-insensitive so a sentence can open with "Ticket prefix", which also loosens the
 * captured group — `checkTicketPrefix` re-tests it against `TICKET_PREFIX_SHAPE`, because
 * with `i` the group would otherwise happily capture the word "the".
 */
const TICKET_PREFIX_CLAIM =
  /\b(?:ticket|issue|jira)[ _-]?(?:prefix|key)\b(?:\s*(?:is|=|:))?\s*[`'"]?([A-Za-z][A-Za-z0-9]{1,9})\b/gi

/**
 * The looser form: a `PREFIX-<number>` token, where the number may be a placeholder,
 * because `URM-<n>` in "Commit subject … `URM-<n>: <description>`" asserts the prefix
 * every bit as firmly as `URM-123` does. The token shape is specific, so a
 * ticket-convention word anywhere on the line is anchor enough.
 */
const TICKET_TOKEN = /\b([A-Z][A-Z0-9]{1,9})-(?:\d{1,6}|<[^>\s]{1,16}>|\{[^}\s]{1,24}\})/g
const TICKET_CONTEXT = /\b(?:ticket|issue|jira|branch|commit)/i

interface Claim {
  line: number
  column: number
  value: string
}

/** Every capture-group-1 match of a global `pattern` across the masked lines. */
const scanClaims = (masked: readonly string[], pattern: RegExp): Claim[] => {
  const claims: Claim[] = []
  // A plain loop rather than `forEach`: `pattern.lastIndex` is state read across
  // iterations of the inner loop, and a callback puts it beyond control-flow analysis.
  for (const [index, line] of masked.entries()) {
    pattern.lastIndex = 0
    let match = pattern.exec(line)
    while (match !== null) {
      claims.push({ line: index, column: match.index, value: match[1] })
      match = pattern.exec(line)
    }
  }
  return claims
}

/** Prefix claims from both forms, deduplicated per line so one line reports once. */
const ticketClaims = (masked: readonly string[]): Claim[] => {
  const claims = scanClaims(masked, TICKET_PREFIX_CLAIM)
  for (const claim of scanClaims(masked, TICKET_TOKEN)) {
    if (TICKET_CONTEXT.test(masked[claim.line])) claims.push(claim)
  }
  return claims
}

const checkTicketPrefix = (masked: readonly string[], ticketPrefix: string): FindingDraft[] => {
  const findings: FindingDraft[] = []
  const reported = new Set<string>()
  // The configured value is only a prefix when it is shaped like one. This repo's is the
  // note `{no jira board/no jira tickets use names instead}`, which says there is no
  // board at all — so any prefix an artifact asserts contradicts it.
  const isPrefix = TICKET_PREFIX_SHAPE.test(ticketPrefix)

  for (const claim of ticketClaims(masked)) {
    // A ticket key is an uppercase project key. Anything else after "ticket prefix" is
    // the sentence continuing, not a value.
    if (!TICKET_PREFIX_SHAPE.test(claim.value)) continue
    if (NOT_TICKET_PREFIXES.has(claim.value)) continue
    if (isPrefix && claim.value === ticketPrefix) continue
    const key = `${String(claim.line)}:${claim.value}`
    if (reported.has(key)) continue
    reported.add(key)

    findings.push({
      line: claim.line + 1,
      column: claim.column,
      message: isPrefix
        ? `Asserts the ticket prefix \`${claim.value}\`, but \`${CONFIG}\` says \`ticket_prefix=${ticketPrefix}\`.`
        : `Asserts the ticket prefix \`${claim.value}\`, but \`${CONFIG}\` says \`ticket_prefix=${ticketPrefix}\` — which is not a prefix, so this repository has no ticket key to use.`,
      remediation: isPrefix
        ? `Delete the hardcoded prefix and point at \`${CONFIG}\`, or correct it to \`${ticketPrefix}\`. Prefer deletion: two sources of truth is the defect.`
        : `Delete the hardcoded prefix and the ticket-numbered branch and commit shapes that depend on it, and point at \`${CONFIG}\` for the naming convention instead.`,
    })
  }

  return findings
}

// --- base and staging branch -----------------------------------------------------------

/**
 * A branch name is only read as a claim when it is in a code span, which is how every
 * convention statement in this repository's guidance writes one. The alternative — reading
 * the next bare word after the anchor — captures `the` out of "into the main branch".
 */
const BASE_BRANCH_CLAIMS: readonly RegExp[] = [
  /\b(?:base|target|default)[ _-]branch\b[^\n]{0,24}?`([^`\n]{1,60})`/gi,
  /\b(?:targets?|targeting|against)\s+(?:the\s+)?(?:branch\s+)?`([^`\n]{1,60})`/gi,
]

const STAGING_BRANCH_CLAIMS: readonly RegExp[] = [
  /\b(?:staging|integration)[ _-]branch\b[^\n]{0,24}?`([^`\n]{1,60})`/gi,
]

/** Branch-shaped: what `git check-ref-format` would accept, minus template syntax. */
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,60}$/

const checkBranch = (
  masked: readonly string[],
  patterns: readonly RegExp[],
  role: string,
  key: string,
  expected: string,
): FindingDraft[] => {
  const findings: FindingDraft[] = []
  const reported = new Set<string>()

  for (const pattern of patterns) {
    for (const claim of scanClaims(masked, pattern)) {
      if (!BRANCH_NAME.test(claim.value)) continue
      if (claim.value === expected) continue
      const seen = `${String(claim.line)}:${claim.value}`
      if (reported.has(seen)) continue
      reported.add(seen)

      findings.push({
        line: claim.line + 1,
        column: claim.column,
        message: `Names \`${claim.value}\` as the ${role} branch, but \`${CONFIG}\` says \`${key}=${expected}\`.`,
        remediation: `Delete the hardcoded branch name and point at \`${CONFIG}\`, or correct it to \`${expected}\`. Prefer deletion: two sources of truth is the defect.`,
      })
    }
  }

  return findings
}

export const configMismatch = defineRule(
  {
    id: 'conventions/config-mismatch',
    defaultSeverity: 'warn',
    statement: `No artifact asserts a repository slug, ticket prefix, or base/staging branch that contradicts \`${CONFIG}\`.`,
    rationale:
      'Two sources of truth for a convention is the defect. An agent that believes the instructions file works to a ticket prefix that does not exist and pushes to a repository that is not this one — and the file it believes is the one that says “never invent them”.',
    appliesTo: APPLIES_TO,
    dimension: 'correctness',
    scope: 'artifact',
    needs: ['view'],
  },
  (input) => {
    const artifact = requireArtifact(input)
    const view = artifact.view
    const config = input.skillsConfig
    // No config means no configured convention, so there is nothing to contradict.
    if (view === null || config === null) return []

    const conventions = readConventions(config)
    const masked = claimLines(view)
    const findings: FindingDraft[] = []

    if (conventions.slug !== null) {
      findings.push(...checkSlug(view, masked, input.index, conventions.slug))
    }
    if (conventions.ticketPrefix !== null) {
      findings.push(...checkTicketPrefix(masked, conventions.ticketPrefix))
    }
    if (conventions.baseBranch !== null) {
      findings.push(
        ...checkBranch(masked, BASE_BRANCH_CLAIMS, 'base', 'base_branch', conventions.baseBranch),
      )
    }
    if (conventions.stagingBranch !== null) {
      findings.push(
        ...checkBranch(
          masked,
          STAGING_BRANCH_CLAIMS,
          'staging',
          'staging_branch',
          conventions.stagingBranch,
        ),
      )
    }

    return findings.sort(
      (a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0),
    )
  },
)
