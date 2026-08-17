/**
 * The shared fixture builders every rule suite uses.
 *
 * Shared rather than copy-pasted per suite, for the same reason `defineRule` exists:
 * twenty suites each building an `Artifact` by hand is how a diff crosses the
 * duplication limit (Constitution IV). More importantly, they are what makes SC-004's
 * fires / does-not-fire pair two lines per rule instead of twenty — and a pair that is
 * cheap to write is a pair that actually gets written for every rule.
 */
import { parseFrontmatter, parseMarkdown, parseSkillMeta, parseSuppressions } from './artifact'
import type { Artifact, MetaBlock } from './artifact'
import type { DiffContext, Finding, LocalRule, RuleContext, RuleInput } from './rules/define'
import { buildPathIndex } from './scope'
import type { ArtifactKind, PathIndex } from './scope'

export interface ArtifactFixtureOptions {
  path?: string
  kind?: ArtifactKind
  content?: string
  skillRoot?: string | null
  /** Set to model an unreadable artifact — content becomes null, as the loader would leave it. */
  readError?: Artifact['readError']
}

/** Build an in-memory `Artifact` exactly as `loadArtifact` would have produced it. */
export const artifactFixture = (options: ArtifactFixtureOptions = {}): Artifact => {
  const path = options.path ?? 'tooling/skills/catalog/example/SKILL.md'
  const kind = options.kind ?? 'catalog-skill'
  const content = options.content ?? '# Example\n\n## Done When\n\n- [ ] it works\n'
  const readError = options.readError ?? null

  if (readError !== null) {
    return {
      path,
      kind,
      content: null,
      readError,
      view: null,
      meta: null,
      tokens: null,
      skillRoot: options.skillRoot ?? null,
      suppressions: [],
    }
  }

  const isMeta = kind === 'catalog-meta'
  return {
    path,
    kind,
    content,
    readError: null,
    view: isMeta ? null : parseMarkdown(content),
    meta: isMeta ? parseSkillMeta(content) : (parseFrontmatter(content).meta ?? null),
    tokens: null,
    skillRoot: options.skillRoot ?? null,
    suppressions: parseSuppressions(content, isMeta ? 'skill-meta' : 'markdown'),
  }
}

export interface MetaFixtureFields {
  name?: string
  version?: string
  description?: string
  argumentHint?: string
  requires?: string
  assets?: string
  nextSteps?: string[]
  /** Appended verbatim, for the malformed cases duplicate/stray rules exist to catch. */
  extraLines?: string[]
}

/** Build a `skill.meta` artifact. Field order mirrors the real catalog files. */
export const metaFixture = (
  fields: MetaFixtureFields = {},
  path = 'tooling/skills/catalog/example/skill.meta',
): Artifact => {
  const lines: string[] = []
  const push = (key: string, value: string | undefined): void => {
    if (value !== undefined) lines.push(`${key}=${value}`)
  }
  push('name', fields.name ?? 'example')
  push('version', fields.version ?? '1.0.0')
  push('description', fields.description ?? 'Does a thing. Use when: you need the thing done.')
  push('argument_hint', fields.argumentHint)
  push('requires', fields.requires ?? '')
  push('assets', fields.assets)
  for (const step of fields.nextSteps ?? []) lines.push(`next_step=${step}`)
  lines.push(...(fields.extraLines ?? []))

  return artifactFixture({
    path,
    kind: 'catalog-meta',
    content: `${lines.join('\n')}\n`,
    skillRoot: path.replace(/\/skill\.meta$/, ''),
  })
}

/** Build a `.claude/` pointer artifact with the given frontmatter. */
export const pointerFixture = (
  fields: { name?: string; description?: string; argumentHint?: string; body?: string } = {},
  path = '.claude/skills/example/SKILL.md',
): Artifact => {
  const front = [`name: ${fields.name ?? 'example'}`]
  front.push(`description: '${fields.description ?? 'Does a thing. Use when: you need it.'}'`)
  if (fields.argumentHint !== undefined) front.push(`argument-hint: '${fields.argumentHint}'`)
  const body =
    fields.body ??
    '> **IMPORTANT:** You MUST read and follow the shared skill file at `.agents/skills/example/SKILL.md` for the full procedure.'
  return artifactFixture({
    path,
    kind: 'agent-pointer',
    content: `---\n${front.join('\n')}\n---\n\n${body}\n`,
    skillRoot: path.replace(/\/SKILL\.md$/, ''),
  })
}

export interface ContextFixtureOptions {
  universe?: readonly Artifact[]
  /** Paths the index should report as existing. Directories are derived from them. */
  paths?: readonly string[]
  skillsConfig?: MetaBlock | null
  deleted?: readonly string[]
  diff?: DiffContext | null
}

/** The repository conventions the real `.agents/skills.config` records. */
export const skillsConfigFixture = (overrides: Record<string, string> = {}): MetaBlock => {
  const values: Record<string, string> = {
    ticket_prefix: '{no jira board/no jira tickets use names instead}',
    staging_branch: 'staging',
    base_branch: 'main',
    repo_owner: 'bluetel',
    repo_name: 'bluetel-ai',
    ...overrides,
  }
  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
  return parseSkillMeta(`${body}\n`)
}

/** Build the non-artifact half of a rule's input. */
export const contextFixture = (options: ContextFixtureOptions = {}): RuleContext => ({
  universe: options.universe ?? [],
  index: options.paths ? buildPathIndex(options.paths) : buildPathIndex([]),
  skillsConfig: options.skillsConfig === undefined ? skillsConfigFixture() : options.skillsConfig,
  deleted: options.deleted ?? [],
  diff: options.diff ?? null,
})

/** A path index over the given tracked paths, for suites that only need one. */
export const indexFixture = (paths: readonly string[]): PathIndex => buildPathIndex(paths)

/** Run one rule over one artifact and return its findings. */
export const runRule = (
  rule: LocalRule,
  artifact: Artifact | null,
  context: ContextFixtureOptions = {},
): Finding[] => {
  const input: RuleInput = { ...contextFixture(context), artifact }
  return rule.check(input)
}

/**
 * SC-004's positive half: the rule fires on a violating artifact, and says something
 * useful about it. Asserting the message is non-empty here is what stops a rule
 * "passing" its test by firing with nothing to say.
 */
export const expectFires = (
  rule: LocalRule,
  artifact: Artifact | null,
  context: ContextFixtureOptions = {},
): Finding[] => {
  const findings = runRule(rule, artifact, context)
  if (findings.length === 0) {
    throw new Error(`expected ${rule.id} to fire on ${artifact?.path ?? 'the set'}, but it did not`)
  }
  for (const finding of findings) {
    if (finding.message.trim().length === 0 || finding.remediation.trim().length === 0) {
      throw new Error(`${rule.id} fired with an empty message or remediation`)
    }
  }
  return findings
}

/**
 * SC-004's negative half, and the more important one: it is what keeps the gate from
 * being ignored. A rule with only a fires-case is a rule whose false-positive rate
 * nobody has measured — which is how a 40-hits-to-1-real-defect scan ships.
 */
export const expectDoesNotFire = (
  rule: LocalRule,
  artifact: Artifact | null,
  context: ContextFixtureOptions = {},
): void => {
  const findings = runRule(rule, artifact, context)
  if (findings.length > 0) {
    throw new Error(
      `expected ${rule.id} not to fire on ${artifact?.path ?? 'the set'}, but it reported: ${findings
        .map((finding) => `${finding.path}:${finding.line} ${finding.message}`)
        .join('; ')}`,
    )
  }
}
