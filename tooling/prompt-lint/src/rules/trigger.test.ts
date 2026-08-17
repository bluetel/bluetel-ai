import { describe, expect, it } from 'vitest'

import { artifactFixture, expectDoesNotFire, expectFires, metaFixture } from '../test-helpers'

import { useWhenTrigger } from './trigger'

// The corpus below is quoted verbatim from `tooling/skills/catalog/*/skill.meta`, so these
// three tokens are the catalog's spelling, not this file's: `dedup` and `acli` appear in the
// `review` and `jira-ticket` descriptions, and `taskstoissues` is a skill's directory name.
// Ignored locally rather than added to `cspell.json`, because they are quoted data — the
// dictionary should not grow to accommodate a fixture.
// cspell:ignore dedup acli taskstoissues

/**
 * The seven catalog descriptions that carry the clause today, verbatim.
 *
 * These are the corpus the matcher has to accept, and they are quoted rather than
 * paraphrased for exactly that reason: a synthetic `Use when: ...` ideal would prove only
 * that the regex matches itself. Each of these is also the description of the matching
 * `.claude/` pointer, byte for byte — `install/pointer-mismatch` is what keeps that true —
 * so the same seven strings exercise both artifact kinds.
 */
const CARRY_THE_CLAUSE: [string, string][] = [
  [
    'merging',
    'Merging a feature branch into staging. Use when: user explicitly asks to merge into staging or deploy to staging.',
  ],
  [
    'pr-creation',
    'Creating a pull request for the current feature branch. Use when: user asks to create a PR, open a PR, or make a pull request.',
  ],
  [
    'skills-install',
    'Install, list, and update the shared @bluetel-ai/skills in this project — re-fetches the latest catalog on demand. Use when: adding, updating, or listing shared skills.',
  ],
  [
    'review',
    'Structured code review using tiered persona agents, confidence-gated findings, and a merge/dedup pipeline. Monitors GitHub PR CI status (Actions, lint, typecheck, tests). Use when: reviewing code changes before creating a PR, or verifying a PR is ready to merge.',
  ],
  [
    'jira-ticket',
    'Create and manage Jira tickets (bugs/tasks) via acli, linking to the configured epic and active sprint. Use when: creating a Jira ticket, raising a bug, logging a task, or moving an issue to a sprint.',
  ],
  [
    'copywriting',
    'Write, rewrite, or improve marketing copy for any page — homepage, landing pages, pricing pages, feature pages, about pages, or product pages. Use when: "write copy for," "improve this copy," "rewrite this page," "marketing copy," "headline help," or "CTA copy."',
  ],
  [
    'frontend-design',
    "Create distinctive, production-grade frontend interfaces with high design quality. Use when: building or styling web components, pages, layouts, or applications (landing pages, dashboards, React components, HTML/CSS), or beautifying any web UI. Works from the app's DESIGN.md and gates token changes on design-lint.",
  ],
]

/**
 * The ten `speckit-*` descriptions, verbatim — the live violations the contract counts
 * and T058 baselines. Every one of them states what the command does and stops there.
 */
const STATE_ONLY_WHAT: [string, string][] = [
  [
    'speckit-analyze',
    'Perform a non-destructive cross-artifact consistency and quality analysis across spec.md, plan.md, and tasks.md after task generation.',
  ],
  [
    'speckit-checklist',
    'Generate a custom checklist for the current feature based on user requirements.',
  ],
  [
    'speckit-clarify',
    'Identify underspecified areas in the current feature spec by asking up to 5 highly targeted clarification questions and encoding answers back into the spec.',
  ],
  [
    'speckit-constitution',
    'Create or update the project constitution from interactive or provided principle inputs, ensuring all dependent templates stay in sync.',
  ],
  [
    'speckit-converge',
    "Assess the current codebase against the feature's spec, plan, and tasks, then append any remaining unbuilt work as new tasks to tasks.md so implement can complete it.",
  ],
  [
    'speckit-implement',
    'Execute the implementation plan by processing and executing all tasks defined in tasks.md',
  ],
  [
    'speckit-plan',
    'Execute the implementation planning workflow using the plan template to generate design artifacts.',
  ],
  [
    'speckit-specify',
    'Create or update the feature specification from a natural language feature description.',
  ],
  [
    'speckit-tasks',
    'Generate an actionable, dependency-ordered tasks.md for the feature based on available design artifacts.',
  ],
  [
    'speckit-taskstoissues',
    'Convert existing tasks into actionable, dependency-ordered GitHub issues for the feature based on available design artifacts.',
  ],
]

/**
 * A pointer built by hand rather than with `pointerFixture`, which single-quotes the
 * description — and three of the seven real descriptions contain quote characters of their
 * own. The real pointers double-quote when they have to; `parseFrontmatter` strips one
 * layer either way, so quoting with `"` keeps every real string readable as itself.
 */
const pointer = (description: string, name = 'example') =>
  artifactFixture({
    path: `.claude/skills/${name}/SKILL.md`,
    kind: 'agent-pointer',
    content: `---\nname: ${name}\ndescription: "${description.replaceAll('"', "'")}"\n---\n\nBody.\n`,
  })

describe('skill/use-when-trigger', () => {
  describe('fires on a real description that never says when', () => {
    it.each(STATE_ONLY_WHAT)('%s, as a skill.meta', (name, description) => {
      const [finding] = expectFires(
        useWhenTrigger,
        metaFixture({ name, description }, `tooling/skills/catalog/${name}/skill.meta`),
      )
      expect(finding.message).toContain('no `Use when:` clause')
      expect(finding.remediation).toContain('Use when:')
    })

    it.each(STATE_ONLY_WHAT)('%s, as a pointer', (name, description) => {
      expectFires(useWhenTrigger, pointer(description, name))
    })
  })

  describe('does not fire on a real description that carries the clause', () => {
    it.each(CARRY_THE_CLAUSE)('%s, as a skill.meta', (name, description) => {
      expectDoesNotFire(
        useWhenTrigger,
        metaFixture({ name, description }, `tooling/skills/catalog/${name}/skill.meta`),
      )
    })

    it.each(CARRY_THE_CLAUSE)('%s, as a pointer', (name, description) => {
      expectDoesNotFire(useWhenTrigger, pointer(description, name))
    })
  })

  it('reports the description’s own line, not the block’s first', () => {
    const [finding] = expectFires(useWhenTrigger, metaFixture({ description: 'Does a thing.' }))
    // `metaFixture` writes name, then version, then description.
    expect(finding.line).toBe(3)
  })

  // The marker is matched more loosely than the canonical form because a clause doing the
  // job with different punctuation is not the defect this rule is about.
  describe('accepts a non-canonical marker', () => {
    it.each([
      ['lower case', 'Does a thing. use when: you need the thing done.'],
      ['no colon', 'Does a thing. Use when you need the thing done.'],
      ['an intervening this', 'Does a thing. Use this when: you need the thing done.'],
      ['an intervening it', 'Does a thing. Use it when you need the thing done.'],
      ['whenever', 'Does a thing. Use whenever the user asks for the thing.'],
      ['mid-sentence, after Also', 'Does a thing. Also use when the user says “do the thing”.'],
    ])('%s', (_label, description) => {
      expectDoesNotFire(useWhenTrigger, metaFixture({ description }))
    })
  })

  // A warn that accepts every phrasing of every intent measures nothing, so the near
  // misses stay findings and the remediation names the form to use.
  describe('rejects a near miss that is not the clause', () => {
    it.each([
      ['Useful when, a different word', 'Does a thing. Useful when: you need the thing done.'],
      ['a bare When, which reads as a label', 'Does a thing. When: you need the thing done.'],
      ['Triggers on, a near synonym', 'Does a thing. Triggers on: you need the thing done.'],
      ['Applies to, a near synonym', 'Does a thing. Applies to: pages that need the thing.'],
    ])('%s', (_label, description) => {
      expectFires(useWhenTrigger, metaFixture({ description }))
    })
  })

  describe('a marker with no situation after it', () => {
    it('fires on a one-word clause, quoting it', () => {
      const [finding] = expectFires(
        useWhenTrigger,
        metaFixture({ description: 'A thing. Use when: needed.' }),
      )
      expect(finding.message).toContain('names no situation')
      expect(finding.message).toContain('`needed.`')
    })

    it('fires on a marker with nothing after it at all', () => {
      const [finding] = expectFires(
        useWhenTrigger,
        metaFixture({ description: 'A thing. Use when:' }),
      )
      expect(finding.message).toContain('names no situation')
    })

    it('does not fire on the shortest clause that names a verb and its object', () => {
      expectDoesNotFire(
        useWhenTrigger,
        metaFixture({ description: 'A thing. Use when: creating a ticket.' }),
      )
    })
  })

  // `meta/required-field` already reports an absent description, and its remediation
  // already names this clause. Two rules reporting one missing field is how a report
  // starts getting skimmed.
  describe('stays silent when there is no description to judge', () => {
    it.each([
      ['empty', ''],
      ['whitespace only', '   '],
    ])('%s', (_label, description) => {
      expectDoesNotFire(useWhenTrigger, metaFixture({ description }))
    })

    it('absent entirely', () => {
      expectDoesNotFire(
        useWhenTrigger,
        artifactFixture({
          path: 'tooling/skills/catalog/example/skill.meta',
          kind: 'catalog-meta',
          content: 'name=example\nversion=1.0.0\n',
        }),
      )
    })
  })

  it('applies to both metadata kinds and nothing else', () => {
    expect(useWhenTrigger.appliesTo).toEqual(['catalog-meta', 'agent-pointer'])
    expect(useWhenTrigger.defaultSeverity).toBe('warn')
  })
})
